import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AssetManifestSchema, compositionDurationMs, type Scene } from '@vpa/shared';
import { projectFiles } from '../project/paths.js';
import { resolveSafeProjectPath } from '../project/safe-path.js';

const execFileAsync = promisify(execFile);
const esc = (value: string) => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll(':', '\\:').replaceAll('%', '\\%');

export async function applyCompositionForeground(projectRoot: string, scene: Scene, inputPath: string, run: (args: string[]) => Promise<void> = async (args) => { await execFileAsync('ffmpeg', args, { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 }); }): Promise<string | null> {
  if (!scene.composition) return null;
  const foreground = (scene.visual_effects ?? []).filter((effect) => ['camera', 'logo', 'title', 'lower-third'].includes(effect.type));
  const hasLinkedCamera = scene.composition.clips.some((clip) => clip.linked_tracks.some((track) => track.role === 'camera'));
  if (!foreground.length && !hasLinkedCamera) return null;
  const manifest = AssetManifestSchema.parse(JSON.parse(await readFile(projectFiles(projectRoot).assetManifest, 'utf8')));
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const fingerprint = createHash('sha256').update(JSON.stringify({ inputPath, composition: scene.composition, foreground, checksums: manifest.assets.map((asset) => asset.checksum) })).digest('hex').slice(0, 20);
  const dir = path.join(projectRoot, 'renders', '.composition');
  const output = path.join(dir, `${scene.id}-foreground-${fingerprint}.mp4`);
  if (existsSync(output)) return output;
  const args = ['-y', '-i', inputPath];
  const filters: string[] = [];
  let current = '0:v';
  let inputIndex = 1;
  let step = 0;
  const duration = compositionDurationMs(scene.composition) / 1_000;

  for (const clip of scene.composition.clips) {
    const cameraTrack = clip.linked_tracks.find((track) => track.role === 'camera' && assets.get(track.asset_id)?.media_kind === 'video');
    if (!cameraTrack) continue;
    const camera = assets.get(cameraTrack.asset_id)!;
    args.push('-i', await resolveSafeProjectPath(projectRoot, camera.source));
    const cameraEffect = foreground.find((effect) => effect.type === 'camera' && effect.clip_instance_id === clip.id);
    const rect = cameraEffect?.rect ?? { x: 0.72, y: 0.7, width: 0.25, height: 0.25 };
    const sourceStart = Math.max(0, clip.source_in_ms - cameraTrack.source_offset_ms) / 1_000;
    const sourceEnd = Math.max(sourceStart * 1_000 + 1, clip.source_out_ms - cameraTrack.source_offset_ms) / 1_000;
    const timelineStart = clip.timeline_start_ms / 1_000;
    const activeStart = cameraEffect ? timelineStart + (cameraEffect.source_in_ms - clip.source_in_ms) / 1_000 : timelineStart;
    const activeEnd = cameraEffect ? timelineStart + (cameraEffect.source_out_ms - clip.source_in_ms) / 1_000 : timelineStart + (clip.source_out_ms - clip.source_in_ms) / 1_000;
    filters.push(`[${inputIndex++}:v]trim=start=${sourceStart.toFixed(3)}:end=${sourceEnd.toFixed(3)},setpts=PTS-STARTPTS+${timelineStart.toFixed(3)}/TB[camraw${step}]`);
    filters.push(`[camraw${step}][${current}]scale2ref=w=main_w*${rect.width}:h=main_h*${rect.height}[cam${step}][base${step}]`);
    filters.push(`[base${step}][cam${step}]overlay=x=W*${rect.x}:y=H*${rect.y}:eof_action=pass:shortest=0:enable='between(t,${activeStart.toFixed(3)},${activeEnd.toFixed(3)})'[fg${step}]`);
    current = `fg${step++}`;
  }
  for (const effect of foreground) {
    const clip = scene.composition.clips.find((candidate) => candidate.id === effect.clip_instance_id);
    if (!clip || effect.type === 'camera') continue;
    const start = (clip.timeline_start_ms + effect.source_in_ms - clip.source_in_ms) / 1_000;
    const end = (clip.timeline_start_ms + effect.source_out_ms - clip.source_in_ms) / 1_000;
    if (effect.type === 'logo') {
      const logo = assets.get(effect.asset_id);
      if (!logo || logo.media_kind !== 'image') throw new Error('Logo effect references an unavailable image asset.');
      args.push('-loop', '1', '-t', duration.toFixed(3), '-i', await resolveSafeProjectPath(projectRoot, logo.source));
      filters.push(`[${inputIndex++}:v][${current}]scale2ref=w=main_w*${effect.rect.width}:h=main_h*${effect.rect.height}[logo${step}][base${step}]`);
      filters.push(`[base${step}][logo${step}]overlay=x=W*${effect.rect.x}:y=H*${effect.rect.y}:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[fg${step}]`);
    } else if (effect.type === 'title' || effect.type === 'lower-third') {
      const fadeSec = Math.min(0.25, Math.max(0.05, (end - start) / 3));
      const alpha = `if(lt(t\\,${(start + fadeSec).toFixed(3)})\\,(t-${start.toFixed(3)})/${fadeSec.toFixed(3)}\\,if(gt(t\\,${(end - fadeSec).toFixed(3)})\\,(${end.toFixed(3)}-t)/${fadeSec.toFixed(3)}\\,1))`;
      const y = effect.preset === 'slide-up'
        ? `if(lt(t\\,${(start + fadeSec).toFixed(3)})\\,h*${Math.min(1, effect.rect.y + 0.08)}-(t-${start.toFixed(3)})/${fadeSec.toFixed(3)}*h*0.08\\,h*${effect.rect.y})`
        : `h*${effect.rect.y}`;
      filters.push(`[${current}]drawtext=text='${esc(effect.text)}':x=w*${effect.rect.x}:y='${y}':fontsize=max(20\\,h*0.05):fontcolor=white:alpha='${alpha}':box=1:boxcolor=black@0.72:boxborderw=12:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[fg${step}]`);
    }
    current = `fg${step++}`;
  }
  await mkdir(dir, { recursive: true });
  args.push('-filter_complex', filters.join(';'), '-map', `[${current}]`, '-map', '0:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', output);
  await run(args);
  return output;
}
