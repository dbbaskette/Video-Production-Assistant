import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AssetManifestSchema,
  SceneCompositionSchema,
  compositionDurationMs,
  effectiveMixSettings,
  type Asset,
  type AudioMixRole,
  type Scene,
} from '@vpa/shared';
import { projectFiles } from '../project/paths.js';
import { resolveSafeProjectPath } from '../project/safe-path.js';

const execFileAsync = promisify(execFile);

export interface CompositionMaterializeResult {
  path: string;
  durationSec: number;
  hasAudio: boolean;
}

export interface CompositionMaterializeDeps {
  run?: (args: string[]) => Promise<void>;
  hasAudio?: (filePath: string) => Promise<boolean>;
}

async function defaultRun(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', args, { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
}

async function defaultHasAudio(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath,
  ], { timeout: 15_000 });
  return stdout.trim().length > 0;
}

function fadeFilters(durationSec: number, settings: ReturnType<typeof effectiveMixSettings>): string[] {
  const filters = [`volume=${settings.mute ? '-120dB' : `${settings.gain_db}dB`}`];
  const fadeIn = Math.min(durationSec, settings.fade_in_ms / 1_000);
  const fadeOut = Math.min(durationSec, settings.fade_out_ms / 1_000);
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, durationSec - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  return filters;
}

function mixRoleForTrack(role: string): AudioMixRole {
  if (role === 'microphone') return 'microphone';
  if (role === 'system-audio') return 'system-audio';
  if (role === 'camera') return 'camera';
  return 'original';
}

/**
 * Materialize one scene's immutable clip sequence into a derived MP4. The
 * returned file is the common input for preview/export stages; source bytes
 * are read only.
 */
export async function materializeSceneComposition(
  projectRoot: string,
  scene: Scene,
  deps: CompositionMaterializeDeps = {},
): Promise<CompositionMaterializeResult | null> {
  if (!scene.composition) return null;
  const composition = SceneCompositionSchema.parse(scene.composition);
  const manifest = AssetManifestSchema.parse(JSON.parse(await readFile(projectFiles(projectRoot).assetManifest, 'utf8')));
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const durationSec = compositionDurationMs(composition) / 1_000;
  const fingerprint = createHash('sha256').update(JSON.stringify({ composition, checksums: composition.clips.flatMap((clip) => [assets.get(clip.source_asset_id)?.checksum, ...clip.linked_tracks.map((track) => assets.get(track.asset_id)?.checksum)]) })).digest('hex').slice(0, 20);
  const outputDir = path.join(projectRoot, 'renders', '.composition');
  const outputPath = path.join(outputDir, `${scene.id}-${fingerprint}.mp4`);

  const run = deps.run ?? defaultRun;
  const hasAudioStream = deps.hasAudio ?? defaultHasAudio;
  const args: string[] = ['-y'];
  const filters: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  let inputIndex = 0;

  const addInput = async (asset: Asset, imageDuration?: number): Promise<number> => {
    const absolute = await resolveSafeProjectPath(projectRoot, asset.source);
    const index = inputIndex++;
    if (asset.media_kind === 'image') args.push('-loop', '1', '-t', (imageDuration ?? durationSec).toFixed(3), '-i', absolute);
    else args.push('-i', absolute);
    return index;
  };

  for (const [clipIndex, clip] of composition.clips.entries()) {
    const primary = assets.get(clip.source_asset_id);
    if (!primary || !['video', 'image'].includes(primary.media_kind)) throw new Error('Composition contains an unavailable visual source.');
    const clipDuration = (clip.source_out_ms - clip.source_in_ms) / 1_000;
    const primaryIndex = await addInput(primary, clipDuration);
    const base = `vbase${clipIndex}`;
    if (primary.media_kind === 'image') {
      filters.push(`[${primaryIndex}:v]trim=duration=${clipDuration.toFixed(3)},setpts=PTS-STARTPTS[${base}]`);
    } else {
      filters.push(`[${primaryIndex}:v]trim=start=${(clip.source_in_ms / 1_000).toFixed(3)}:end=${(clip.source_out_ms / 1_000).toFixed(3)},setpts=PTS-STARTPTS[${base}]`);
    }

    const cameraTrack = clip.linked_tracks.find((track) => track.role === 'camera' && assets.get(track.asset_id)?.media_kind === 'video');
    if (cameraTrack) {
      const camera = assets.get(cameraTrack.asset_id)!;
      const cameraIndex = await addInput(camera);
      const sourceStartMs = Math.max(0, clip.source_in_ms - cameraTrack.source_offset_ms);
      const sourceEndMs = Math.max(sourceStartMs + 1, clip.source_out_ms - cameraTrack.source_offset_ms);
      const delaySec = Math.max(0, cameraTrack.source_offset_ms - clip.source_in_ms) / 1_000;
      filters.push(`[${cameraIndex}:v]trim=start=${(sourceStartMs / 1_000).toFixed(3)}:end=${(sourceEndMs / 1_000).toFixed(3)},setpts=PTS-STARTPTS+${delaySec.toFixed(3)}/TB,scale=iw*0.25:ih*0.25[cam${clipIndex}]`);
      filters.push(`[${base}][cam${clipIndex}]overlay=W-w-24:H-h-24:eof_action=pass:shortest=0[vclip${clipIndex}]`);
    } else {
      filters.push(`[${base}]null[vclip${clipIndex}]`);
    }
    videoLabels.push(`[vclip${clipIndex}]`);

    const originalSettings = effectiveMixSettings(composition, 'original');
    if (primary.media_kind === 'video' && !originalSettings.mute) {
      const absolute = await resolveSafeProjectPath(projectRoot, primary.source);
      if (await hasAudioStream(absolute)) {
        const label = `aorig${clipIndex}`;
        filters.push(`[${primaryIndex}:a]atrim=start=${(clip.source_in_ms / 1_000).toFixed(3)}:end=${(clip.source_out_ms / 1_000).toFixed(3)},asetpts=PTS-STARTPTS,${fadeFilters(clipDuration, originalSettings).join(',')},adelay=${clip.timeline_start_ms}|${clip.timeline_start_ms}[${label}]`);
        audioLabels.push(`[${label}]`);
      }
    }

    for (const [trackIndex, track] of clip.linked_tracks.entries()) {
      const asset = assets.get(track.asset_id);
      if (!asset || asset.media_kind !== 'audio') continue;
      const settings = effectiveMixSettings(composition, mixRoleForTrack(track.role));
      if (settings.mute) continue;
      const sourceStartMs = Math.max(0, clip.source_in_ms - track.source_offset_ms);
      const sourceEndMs = Math.max(sourceStartMs + 1, clip.source_out_ms - track.source_offset_ms);
      const withinClipDelayMs = Math.max(0, track.source_offset_ms - clip.source_in_ms);
      const assetIndex = await addInput(asset);
      const label = `alink${clipIndex}_${trackIndex}`;
      filters.push(`[${assetIndex}:a]atrim=start=${(sourceStartMs / 1_000).toFixed(3)}:end=${(sourceEndMs / 1_000).toFixed(3)},asetpts=PTS-STARTPTS,${fadeFilters(clipDuration, settings).join(',')},adelay=${clip.timeline_start_ms + withinClipDelayMs}|${clip.timeline_start_ms + withinClipDelayMs}[${label}]`);
      audioLabels.push(`[${label}]`);
    }
  }

  const videoOutput = composition.clips.length === 1 ? '[vclip0]' : '[vout]';
  if (composition.clips.length > 1) filters.push(`${videoLabels.join('')}concat=n=${composition.clips.length}:v=1:a=0[vout]`);
  const hasAudio = audioLabels.length > 0;
  if (hasAudio) filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=duration=${durationSec.toFixed(3)}[aout]`);

  await mkdir(outputDir, { recursive: true });
  if (!existsSync(outputPath)) {
    args.push('-filter_complex', filters.join(';'), '-map', videoOutput);
    if (hasAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
    else args.push('-an');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', outputPath);
    await run(args);
  }
  return { path: outputPath, durationSec, hasAudio };
}
