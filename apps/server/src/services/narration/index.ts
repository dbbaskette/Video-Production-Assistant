import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TtsService } from '../tts/index.js';
import type { LlmClient } from '../llm/index.js';
import type { Expressiveness } from '@vpa/shared';
import { prepareExpressiveText } from '../tts/expressiveness.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../storyboard/index.js';
import { generateSrt, generateVtt } from './subtitles.js';

export interface NarrationInput {
  projectPath: string;
  sceneId: string;
  engine: string;
  voice: string;
  speed?: number;
  expressiveness?: Expressiveness;
}

export interface NarrationResult {
  audioPath: string; // relative: narration/scene-01.mp3
  srtPath: string;
  vttPath: string;
  durationSec: number;
  timingCount: number;
  unsupportedEmotives: string[];
}

export interface ChunkNarrationInput {
  projectPath: string;
  sceneId: string;
  chunkIndex: number;
  text: string;
  engine: string;
  voice: string;
  speed?: number;
  expressiveness?: Expressiveness;
}

export interface ChunkNarrationResult {
  chunkIndex: number;
  audioPath: string;
  durationSec: number;
  timingCount: number;
  unsupportedEmotives: string[];
}

/** Split script into paragraphs (chunks) by double-newline. */
export function splitIntoParagraphs(script: string): string[] {
  return script
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Split a dialog script into chunks — one per speaker turn.
 * Each line starting with [Speaker X] becomes its own chunk.
 * Falls back to paragraph splitting if no speaker tags found.
 */
export function splitDialogIntoChunks(script: string): string[] {
  // Split on newline before [Speaker X] tags
  const chunks = script
    .split(/\n(?=\[Speaker [A-Z]\])/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // Fall back to paragraph splitting if no speaker tags
  return chunks.length > 1 ? chunks : splitIntoParagraphs(script);
}

/**
 * Generate narration for the full script (legacy single-file mode).
 */
export async function generateNarration(
  input: NarrationInput,
  tts: TtsService,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<NarrationResult> {
  const { projectPath, sceneId, engine, voice, speed } = input;
  const level: Expressiveness = input.expressiveness ?? 'medium';

  // Load storyboard and find scene
  const sb = await loadStoryboard(projectPath);
  if (!sb) throw new Error('No storyboard found');

  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);

  const script = scene.narration?.script;
  if (!script) throw new Error(`Scene ${sceneId} has no script. Generate a script first.`);

  // Check for unsupported emotive tags (non-blocking warning)
  const unsupportedEmotives = tts.checkEmotives(engine, script);

  // Materialise the emotiveness level where the engine needs it in the text
  // (xAI tags); Gemini applies it via the opts below.
  const prepared = await prepareExpressiveText({ text: script, engine, level, llm, workspaceRoot });

  // Generate audio via TTS
  const ttsResult = await tts.generate(engine, prepared, { voice, speed, expressiveness: level });

  // Write audio file
  const narrationDir = join(projectPath, 'narration');
  await mkdir(narrationDir, { recursive: true });

  const audioRelPath = `narration/${sceneId}.mp3`;
  const audioAbsPath = join(projectPath, audioRelPath);
  await writeFile(audioAbsPath, ttsResult.audio);

  // Generate subtitles from timings
  let srtRelPath = `narration/${sceneId}.srt`;
  let vttRelPath = `narration/${sceneId}.vtt`;

  if (ttsResult.timings && ttsResult.timings.length > 0) {
    const srtContent = generateSrt(ttsResult.timings);
    const vttContent = generateVtt(ttsResult.timings);

    await writeFile(join(projectPath, srtRelPath), srtContent, 'utf-8');
    await writeFile(join(projectPath, vttRelPath), vttContent, 'utf-8');
  } else {
    srtRelPath = '';
    vttRelPath = '';
  }

  // Update storyboard
  const narration = {
    ...(scene.narration ?? {}),
    script, // preserve existing script
    audio: audioRelPath,
    subtitles: srtRelPath
      ? { srt: srtRelPath, vtt: vttRelPath }
      : undefined,
    tts: { engine, voice, speed: speed ?? 1.0, expressiveness: level },
    timings: ttsResult.timings ?? [],
  };

  const updated = updateScene(sb, sceneId, { narration: narration as any });
  await saveStoryboard(projectPath, updated);

  return {
    audioPath: audioRelPath,
    srtPath: srtRelPath,
    vttPath: vttRelPath,
    durationSec: ttsResult.durationSec,
    timingCount: ttsResult.timings?.length ?? 0,
    unsupportedEmotives,
  };
}

/**
 * Generate narration for a single paragraph chunk.
 */
export async function generateChunkNarration(
  input: ChunkNarrationInput,
  tts: TtsService,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<ChunkNarrationResult> {
  const { projectPath, sceneId, chunkIndex, text, engine, voice, speed } = input;
  const level: Expressiveness = input.expressiveness ?? 'medium';

  const sb = await loadStoryboard(projectPath);
  if (!sb) throw new Error('No storyboard found');

  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);

  const unsupportedEmotives = tts.checkEmotives(engine, text);

  // Materialise emotiveness in the text where needed (xAI); Gemini via opts.
  const prepared = await prepareExpressiveText({ text, engine, level, llm, workspaceRoot });

  // Generate audio for this chunk
  const ttsResult = await tts.generate(engine, prepared, { voice, speed, expressiveness: level });

  // Write chunk audio file
  const narrationDir = join(projectPath, 'narration');
  await mkdir(narrationDir, { recursive: true });

  const chunkTag = String(chunkIndex).padStart(2, '0');
  const audioRelPath = `narration/${sceneId}-chunk-${chunkTag}.mp3`;
  await writeFile(join(projectPath, audioRelPath), ttsResult.audio);

  // Update chunk in storyboard — preserve speaker assignment if it exists
  const existingChunks = scene.narration?.chunks ?? [];
  const chunkIdx = existingChunks.findIndex((c) => c.index === chunkIndex);
  const existingSpeaker = chunkIdx >= 0 ? existingChunks[chunkIdx]!.speaker : undefined;

  const newChunk = {
    index: chunkIndex,
    text,
    audio: audioRelPath,
    durationSec: ttsResult.durationSec,
    timings: ttsResult.timings ?? [],
    ...(existingSpeaker ? { speaker: existingSpeaker } : {}),
  };

  // Replace existing chunk or append
  const updatedChunks = [...existingChunks];
  if (chunkIdx >= 0) {
    updatedChunks[chunkIdx] = newChunk;
  } else {
    updatedChunks.push(newChunk);
    updatedChunks.sort((a, b) => a.index - b.index);
  }

  // Mirror the active chunks into the per-mode snapshot so they survive
  // a mode toggle. Default to monologue when mode hasn't been set yet.
  const activeMode = (scene.narration as any)?.mode ?? 'monologue';
  const modeChunksKey = activeMode === 'dialog' ? 'dialogChunks' : 'monologueChunks';

  const narration = {
    ...(scene.narration ?? { script: text }),
    tts: { engine, voice, speed: speed ?? 1.0, expressiveness: level },
    chunks: updatedChunks,
    [modeChunksKey]: updatedChunks,
  };

  const updated = updateScene(sb, sceneId, { narration: narration as any });
  await saveStoryboard(projectPath, updated);

  return {
    chunkIndex,
    audioPath: audioRelPath,
    durationSec: ttsResult.durationSec,
    timingCount: ttsResult.timings?.length ?? 0,
    unsupportedEmotives,
  };
}

// ── Batch generation orchestrator (issues #5 + #8) ───────────────────

export type ChunkSelector = 'all' | 'missing' | 'failed';

export interface BatchProgress {
  type: 'chunk-start' | 'chunk-success' | 'chunk-failed' | 'cancelled' | 'done';
  chunkIndex?: number;
  total: number;
  completed: number;
  failed: number;
  message: string;
  reason?: string;
}

export interface BatchInput {
  projectPath: string;
  sceneId: string;
  engine: string;
  voice: string;
  speed?: number;
  expressiveness?: Expressiveness;
  /** Which chunks to generate. Default: 'missing' — skip ones already rendered. */
  selector?: ChunkSelector;
}

/**
 * Mark one chunk as failed in storyboard.yaml. Persisted so the UI can show
 * the red border + reason after a refresh.
 */
async function markChunkFailed(
  projectPath: string,
  sceneId: string,
  chunkIndex: number,
  reason: string,
): Promise<void> {
  const sb = await loadStoryboard(projectPath);
  if (!sb) return;
  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) return;
  const existing = scene.narration?.chunks ?? [];
  const idx = existing.findIndex((c) => c.index === chunkIndex);
  const failedRecord = { reason: reason.slice(0, 500), at: new Date().toISOString() };
  let updated;
  if (idx >= 0) {
    updated = [...existing];
    updated[idx] = { ...updated[idx]!, failed: failedRecord };
  } else {
    // Build a stub chunk with text from the script (split index)
    const isDialog = (scene.narration?.mode ?? 'monologue') === 'dialog';
    const paragraphs = scene.narration?.script
      ? (isDialog ? splitDialogIntoChunks(scene.narration.script) : splitIntoParagraphs(scene.narration.script))
      : [];
    const text = paragraphs[chunkIndex] ?? '';
    updated = [...existing, { index: chunkIndex, text, failed: failedRecord }];
    updated.sort((a, b) => a.index - b.index);
  }
  const narration = { ...(scene.narration ?? {}), chunks: updated };
  const next = updateScene(sb, sceneId, { narration: narration as any });
  await saveStoryboard(projectPath, next);
}

/**
 * Generate audio for many chunks of a scene with progress callbacks and
 * per-chunk failure persistence.
 *
 * - One chunk failing does NOT stop the rest of the batch.
 * - Failures are persisted to `narration.chunks[i].failed` so the UI can
 *   surface the reason and offer per-chunk retry.
 * - `isCancelled` is checked between chunks to support a cancel button.
 */
export async function generateAllChunks(
  input: BatchInput,
  tts: TtsService,
  llm: LlmClient,
  workspaceRoot: string,
  onProgress: (p: BatchProgress) => void,
  isCancelled: () => boolean = () => false,
): Promise<{ total: number; completed: number; failed: number }> {
  const { projectPath, sceneId, engine, voice, speed, expressiveness, selector = 'missing' } = input;

  const sb = await loadStoryboard(projectPath);
  if (!sb) throw new Error('No storyboard found');
  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);
  if (!scene.narration?.script) throw new Error('Scene has no script to narrate');

  const isDialog = (scene.narration.mode ?? 'monologue') === 'dialog';
  const paragraphs = isDialog
    ? splitDialogIntoChunks(scene.narration.script)
    : splitIntoParagraphs(scene.narration.script);

  const stored = scene.narration.chunks ?? [];
  const allIndices = paragraphs.map((_, i) => i);
  // 'missing' is the default selector and what the Generate All button uses.
  // It originally meant "no audio file rendered yet", but that's too narrow:
  // if the script gets regenerated and the old chunks are still in
  // storyboard.yaml (because the wipe-on-regen path was skipped or the
  // chunks predate that fix), every chunk has an audio path pointing at the
  // OLD paragraph's audio. We need to detect that drift here so Generate
  // All re-renders chunks whose stored text no longer matches the current
  // paragraph at the same index.
  const targetIndices = allIndices.filter((i) => {
    const c = stored.find((s) => s.index === i);
    if (selector === 'all') return true;
    if (selector === 'missing') {
      if (!c?.audio) return true;  // truly missing
      // Stale: paragraph content changed since this chunk was rendered.
      if (c.text !== paragraphs[i]) return true;
      return false;
    }
    if (selector === 'failed') return !!c?.failed;
    return true;
  });

  const total = targetIndices.length;
  let completed = 0;
  let failedCount = 0;

  // In dialog mode, each chunk renders with its assigned speaker's
  // engine/voice/speed (from narration.speakers[A|B|…]). The request's
  // global engine/voice is the fallback for any chunk missing a speaker
  // assignment or speaker config. Monologue mode always uses the global.
  const speakersMap = (scene.narration as { speakers?: Record<string, { engine: string; voice: string; speed?: number }> }).speakers;

  for (const i of targetIndices) {
    if (isCancelled()) {
      onProgress({
        type: 'cancelled',
        total,
        completed,
        failed: failedCount,
        message: `Cancelled after ${completed} of ${total} chunks`,
      });
      return { total, completed, failed: failedCount };
    }
    const text = paragraphs[i]!;
    // Resolve per-chunk voice settings for dialog mode
    let chunkEngine = engine;
    let chunkVoice = voice;
    let chunkSpeed = speed;
    if (isDialog) {
      const storedChunk = stored.find((s) => s.index === i);
      const speakerKey = storedChunk?.speaker
        ?? (text.match(/^\[Speaker ([A-Z])\]/)?.[1] ?? undefined);
      const cfg = speakerKey ? speakersMap?.[speakerKey] : undefined;
      if (cfg) {
        chunkEngine = cfg.engine;
        chunkVoice = cfg.voice;
        chunkSpeed = cfg.speed ?? speed;
      }
    }
    onProgress({
      type: 'chunk-start',
      chunkIndex: i,
      total,
      completed,
      failed: failedCount,
      message: `Generating chunk ${completed + failedCount + 1}/${total}`,
    });
    try {
      await generateChunkNarration(
        { projectPath, sceneId, chunkIndex: i, text, engine: chunkEngine, voice: chunkVoice, speed: chunkSpeed, expressiveness },
        tts,
        llm,
        workspaceRoot,
      );
      completed += 1;
      onProgress({
        type: 'chunk-success',
        chunkIndex: i,
        total,
        completed,
        failed: failedCount,
        message: `Chunk ${i} done`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failedCount += 1;
      try {
        await markChunkFailed(projectPath, sceneId, i, reason);
      } catch { /* best-effort */ }
      onProgress({
        type: 'chunk-failed',
        chunkIndex: i,
        total,
        completed,
        failed: failedCount,
        message: `Chunk ${i} failed`,
        reason,
      });
    }
  }

  onProgress({
    type: 'done',
    total,
    completed,
    failed: failedCount,
    message: failedCount === 0 ? `All ${total} chunks generated` : `Done — ${completed} ok, ${failedCount} failed`,
  });
  return { total, completed, failed: failedCount };
}
