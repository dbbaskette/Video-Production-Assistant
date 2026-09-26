import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OutputVariant, Scene, Storyboard, VisualEffect } from '@vpa/shared';
import { loadStoryboard, saveStoryboard } from '../storyboard/index.js';
import { projectFiles } from '../project/paths.js';
import { resolveSafeProjectPath } from '../project/safe-path.js';

function stable(prefix: 'clip' | 'effect', value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function srtTime(milliseconds: number): string {
  const total = Math.max(0, milliseconds);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor(total % 3_600_000 / 60_000);
  const seconds = Math.floor(total % 60_000 / 1_000);
  const millis = total % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function selectedScene(scene: Scene, rangeIds: string[]): Scene | null {
  if (!scene.composition) return null;
  const ranges = rangeIds.map((id) => scene.editorial_ranges?.find((range) => range.id === id)).filter((range) => range !== undefined);
  if (ranges.length === 0) return null;
  let timeline = 0;
  const effects: VisualEffect[] = [];
  const clips = ranges.map((range) => {
    const source = scene.composition!.clips.find((clip) => clip.id === range.clip_instance_id)!;
    const id = stable('clip', `${scene.id}:${range.id}`);
    for (const effect of scene.visual_effects ?? []) {
      if (effect.clip_instance_id !== source.id || effect.source_out_ms <= range.source_in_ms || effect.source_in_ms >= range.source_out_ms) continue;
      effects.push({
        ...effect,
        id: stable('effect', `${effect.id}:${range.id}`),
        clip_instance_id: id,
        source_in_ms: Math.max(effect.source_in_ms, range.source_in_ms),
        source_out_ms: Math.min(effect.source_out_ms, range.source_out_ms),
      });
    }
    const clip = { ...source, id, source_in_ms: range.source_in_ms, source_out_ms: range.source_out_ms, timeline_start_ms: timeline };
    timeline += range.source_out_ms - range.source_in_ms;
    return clip;
  });
  return {
    ...scene,
    composition: { ...scene.composition, clips },
    visual_effects: effects,
    narration: undefined,
    lower_thirds: undefined,
    overlay_render: undefined,
    frame_render: undefined,
    transition: 'cut',
  };
}

function captionTimeline(scene: Scene, sourceInMs: number): number | null {
  const clip = scene.composition?.clips.find((item) => sourceInMs >= item.source_in_ms && sourceInMs < item.source_out_ms);
  return clip ? clip.timeline_start_ms + sourceInMs - clip.source_in_ms : null;
}

export async function prepareVariantSnapshot(projectPath: string, variant: OutputVariant): Promise<Storyboard> {
  const storyboard = await loadStoryboard(projectPath);
  if (!storyboard) throw new Error('variant_storyboard_missing');
  const byScene = new Map<string, string[]>();
  for (const selected of variant.selected_ranges) byScene.set(selected.scene_id, [...(byScene.get(selected.scene_id) ?? []), selected.range_id]);
  const scenes = variant.selected_ranges.length > 0
    ? storyboard.scenes.map((scene) => selectedScene(scene, byScene.get(scene.id) ?? [])).filter((scene): scene is Scene => scene !== null)
    : storyboard.scenes;
  if (scenes.length === 0) throw new Error('variant_selected_ranges_empty');

  const withCaptions = [];
  for (const scene of scenes) {
    const captions = variant.captions.filter((caption) => caption.scene_id === scene.id && caption.accepted);
    if (captions.length === 0 || !scene.transcript) {
      withCaptions.push(scene);
      continue;
    }
    const cues = captions.map((caption) => {
      const start = captionTimeline(scene, caption.source_in_ms);
      const end = captionTimeline(scene, Math.max(caption.source_in_ms, caption.source_out_ms - 1));
      if (start === null || end === null) return null;
      return { start, end: end + 1, text: caption.text };
    }).filter((cue): cue is { start: number; end: number; text: string } => cue !== null);
    if (cues.length === 0) {
      withCaptions.push(scene);
      continue;
    }
    const relative = join('.vpa', 'variants', variant.id, `${scene.id}.srt`);
    const absolute = join(projectPath, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`).join('\n\n') + '\n');
    withCaptions.push({ ...scene, transcript: { ...scene.transcript, subtitles: { srt: relative } } });
  }
  const prepared = { ...storyboard, scenes: withCaptions };
  await saveStoryboard(projectPath, prepared);
  return prepared;
}

export async function resolveVariantNarration(projectPath: string, variant: OutputVariant): Promise<string | null> {
  if (!variant.replace_narration || !variant.narration_replacement?.accepted) return null;
  const manifest = JSON.parse(await readFile(projectFiles(projectPath).assetManifest, 'utf8')) as { assets?: Array<{ id: string; source: string }> };
  const asset = manifest.assets?.find((item) => item.id === variant.narration_replacement!.asset_id);
  if (!asset) throw new Error('variant_narration_asset_missing');
  return resolveSafeProjectPath(projectPath, asset.source);
}
