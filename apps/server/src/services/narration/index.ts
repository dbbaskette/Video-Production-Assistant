import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TtsService } from '../tts/index.js';
import type { LlmClient } from '../llm/index.js';
import type { Expressiveness, NarrationChunk, Scene } from '@vpa/shared';
import { prepareExpressiveText } from '../tts/expressiveness.js';
import { parsePauses, stripTimedPauseTokens } from './pause-parser.js';
import { loadStoryboard, mutateStoryboard, saveStoryboard, updateScene } from '../storyboard/index.js';
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
  /** Trailing silence after this chunk. When omitted, the chunk's existing
   *  gap is preserved (a single-chunk regen shouldn't drop a set pause). */
  gapSec?: number;
  /** Clear the legacy scene-wide audio fields when migrating to chunks. */
  replaceLegacyAudio?: boolean;
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

export interface ScriptChunk {
  text: string;
  gapSec: number;
}

/**
 * Pause-aware chunk derivation — the SINGLE source of chunk boundaries. Every
 * site that derives chunks from a script (generation, failure stubs, the GET
 * narration route) must use this so indices stay aligned.
 *
 * Composes `[pause Xs]` parsing (over the whole script, so a pause on its own
 * line between paragraphs folds correctly) with the existing paragraph / dialog
 * split. A pause's gap lands on the LAST paragraph of the text preceding it.
 */
export function splitScriptIntoChunks(script: string, isDialog: boolean): ScriptChunk[] {
  const out: ScriptChunk[] = [];
  // In dialog mode a `[pause Xs]` mid-turn splits a speaker's line; the
  // continuation would otherwise lose its `[Speaker X]` prefix and resolve to
  // the wrong voice. Carry the last-seen speaker onto such continuations.
  let lastSpeaker: string | null = null;
  for (const seg of parsePauses(script)) {
    const paras = isDialog ? splitDialogIntoChunks(seg.text) : splitIntoParagraphs(seg.text);
    if (paras.length === 0) continue;
    paras.forEach((para, i) => {
      let text = para;
      if (isDialog) {
        const m = text.match(/^\[Speaker ([A-Z])\]/);
        if (m) lastSpeaker = m[1]!;
        else if (lastSpeaker) text = `[Speaker ${lastSpeaker}] ${text}`;
      }
      // The pause gap attaches after the last paragraph of this segment.
      out.push({ text, gapSec: i === paras.length - 1 ? seg.gapSec : 0 });
    });
  }
  return out;
}

/**
 * Generate narration for the full script (legacy single-file mode).
 */
export async function generateNarration(
  input: NarrationInput,
  tts: TtsService,
  llm: LlmClient | undefined,
  workspaceRoot: string,
): Promise<NarrationResult> {
  const { projectPath, sceneId, engine, voice, speed } = input;

  // Load storyboard and find scene
  const sb = await loadStoryboard(projectPath);
  if (!sb) throw new Error('No storyboard found');

  // Effective level: explicit request ?? project default ?? medium.
  const level: Expressiveness =
    input.expressiveness ?? sb.defaults?.tts_expressiveness ?? 'medium';

  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);

  const script = scene.narration?.script;
  if (!script) throw new Error(`Scene ${sceneId} has no script. Generate a script first.`);

  // Check for unsupported emotive tags (non-blocking warning)
  const unsupportedEmotives = tts.checkEmotives(engine, script);

  // Materialise the emotiveness level where the engine needs it in the text
  // (xAI tags); Gemini applies it via the opts below. Strip any timed pause
  // token first — the legacy single-file path has no chunk boundaries to turn
  // it into silence, so it must not be spoken.
  const prepared = await prepareExpressiveText({
    text: stripTimedPauseTokens(script),
    engine,
    level,
    writer: llm,
    workspaceRoot,
  });

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
  llm: LlmClient | undefined,
  workspaceRoot: string,
): Promise<ChunkNarrationResult> {
  const { projectPath, sceneId, chunkIndex, engine, voice, speed } = input;
  // Defensively strip any timed pause token so it can never be spoken, even if
  // this text arrived unprocessed (e.g. a raw generate-chunk API call).
  const text = stripTimedPauseTokens(input.text);

  const sb = await loadStoryboard(projectPath);
  if (!sb) throw new Error('No storyboard found');

  // Effective level: explicit request ?? project default ?? medium.
  const level: Expressiveness =
    input.expressiveness ?? sb.defaults?.tts_expressiveness ?? 'medium';

  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);

  const unsupportedEmotives = tts.checkEmotives(engine, text);

  // Materialise emotiveness in the text where needed (xAI); Gemini via opts.
  const prepared = await prepareExpressiveText({ text, engine, level, writer: llm, workspaceRoot });

  // Generate audio for this chunk
  const ttsResult = await tts.generate(engine, prepared, { voice, speed, expressiveness: level });

  // Prepare the final chunk path. The write happens inside the serialized
  // storyboard mutation after confirming the script still matches.
  const narrationDir = join(projectPath, 'narration');
  await mkdir(narrationDir, { recursive: true });

  const chunkTag = String(chunkIndex).padStart(2, '0');
  const audioRelPath = `narration/${sceneId}-chunk-${chunkTag}.mp3`;

  // Merge the result into a fresh storyboard snapshot after the potentially
  // long model/TTS call. This preserves script, speaker, ordering, and other
  // edits made while audio was being synthesized.
  await mutateStoryboard(projectPath, async (current) => {
    if (!current) throw new Error('No storyboard found');
    const currentScene = current.scenes.find((candidate) => candidate.id === sceneId);
    if (!currentScene) throw new Error(`Scene not found: ${sceneId}`);
    const currentIsDialog = (currentScene.narration?.mode ?? 'monologue') === 'dialog';
    const currentDerived = currentScene.narration?.script
      ? splitScriptIntoChunks(currentScene.narration.script, currentIsDialog)
      : [];
    if (currentDerived[chunkIndex]?.text !== text) {
      throw new Error('Narration script changed during generation');
    }
    await writeFile(join(projectPath, audioRelPath), ttsResult.audio);
    const existingChunks = currentScene.narration?.chunks ?? [];
    const chunkIdx = existingChunks.findIndex((chunk) => chunk.index === chunkIndex);
    const existingSpeaker = chunkIdx >= 0 ? existingChunks[chunkIdx]!.speaker : undefined;
    const gapSec = input.gapSec
      ?? (chunkIdx >= 0 ? existingChunks[chunkIdx]!.gapSec : undefined)
      ?? 0;
    const newChunk = {
      index: chunkIndex,
      text,
      audio: audioRelPath,
      durationSec: ttsResult.durationSec,
      timings: ttsResult.timings ?? [],
      ...(gapSec > 0 ? { gapSec } : {}),
      ...(existingSpeaker ? { speaker: existingSpeaker } : {}),
    };
    const updatedChunks = [...existingChunks];
    if (chunkIdx >= 0) updatedChunks[chunkIdx] = newChunk;
    else {
      updatedChunks.push(newChunk);
      updatedChunks.sort((a, b) => a.index - b.index);
    }
    const activeMode = currentScene.narration?.mode ?? 'monologue';
    const modeChunksKey = activeMode === 'dialog' ? 'dialogChunks' : 'monologueChunks';
    const narration = {
      ...(currentScene.narration ?? { script: text }),
      tts: { engine, voice, speed: speed ?? 1.0, expressiveness: level },
      chunks: updatedChunks,
      [modeChunksKey]: updatedChunks,
    };
    if (input.replaceLegacyAudio) {
      delete narration.audio;
      delete narration.subtitles;
      delete narration.timings;
    }
    return updateScene(current, sceneId, { narration });
  });

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

interface PlannedBatchChunk {
  index: number;
  text: string;
  gapSec: number;
  engine: string;
  voice: string;
  speed?: number;
}

interface BatchNarrationPlan {
  derived: ScriptChunk[];
  stored: NarrationChunk[];
  targets: PlannedBatchChunk[];
}

export type BatchVoiceSelection = Pick<BatchInput, 'engine' | 'voice' | 'speed' | 'selector'>;

export interface NarrationBatchInspection {
  targetCount: number;
  requiresWriting: boolean;
}

/**
 * Build the exact set of chunks a batch request can synthesize, including
 * dialog-only speaker overrides. Routing and generation both consume this
 * plan so dormant or unselected speaker configuration cannot require models
 * that the operation will never invoke.
 */
function planBatchNarration(scene: Scene, input: BatchVoiceSelection): BatchNarrationPlan {
  const isDialog = (scene.narration?.mode ?? 'monologue') === 'dialog';
  const derived = scene.narration?.script
    ? splitScriptIntoChunks(scene.narration.script, isDialog)
    : [];
  const paragraphs = derived.map((chunk) => chunk.text);
  const stored = scene.narration?.chunks ?? [];
  const selector = input.selector ?? 'missing';
  const targetIndices = paragraphs.map((_, index) => index).filter((index) => {
    const chunk = stored.find((candidate) => candidate.index === index);
    if (selector === 'all') return true;
    if (selector === 'missing') {
      if (scene.narration?.audio) return false;
      return !chunk?.audio || chunk.text !== paragraphs[index] || Boolean(chunk.failed);
    }
    if (selector === 'failed') return Boolean(chunk?.failed);
    return true;
  });

  const targets = targetIndices.map((index): PlannedBatchChunk => {
    const text = paragraphs[index]!;
    let engine = input.engine;
    let voice = input.voice;
    let speed = input.speed;
    if (isDialog) {
      const storedChunk = stored.find((candidate) => candidate.index === index);
      const speakerKey = storedChunk?.speaker
        ?? text.match(/^\[Speaker ([A-Z])\]/)?.[1];
      const speaker = speakerKey ? scene.narration?.speakers?.[speakerKey] : undefined;
      if (speaker) {
        engine = speaker.engine;
        voice = speaker.voice;
        speed = speaker.speed ?? input.speed;
      }
    }
    return {
      index,
      text,
      gapSec: derived[index]?.gapSec ?? 0,
      engine,
      voice,
      speed,
    };
  });

  return { derived, stored, targets };
}

export function inspectNarrationBatch(
  scene: Scene,
  input: BatchVoiceSelection,
): NarrationBatchInspection {
  const plan = planBatchNarration(scene, input);
  return {
    targetCount: plan.targets.length,
    requiresWriting: plan.targets.some((chunk) => chunk.engine === 'xai'),
  };
}

export function batchRequiresWriting(scene: Scene, input: BatchVoiceSelection): boolean {
  return inspectNarrationBatch(scene, input).requiresWriting;
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
  await mutateStoryboard(projectPath, (current) => {
    if (!current) throw new Error('No storyboard found');
    const scene = current.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) throw new Error(`Scene not found: ${sceneId}`);
    const existing = scene.narration?.chunks ?? [];
    const idx = existing.findIndex((chunk) => chunk.index === chunkIndex);
    const failedRecord = { reason: reason.slice(0, 500), at: new Date().toISOString() };
    let updated;
    if (idx >= 0) {
      updated = [...existing];
      updated[idx] = { ...updated[idx]!, failed: failedRecord };
    } else {
      const isDialog = (scene.narration?.mode ?? 'monologue') === 'dialog';
      const derived = scene.narration?.script
        ? splitScriptIntoChunks(scene.narration.script, isDialog)
        : [];
      const text = derived[chunkIndex]?.text ?? '';
      updated = [...existing, { index: chunkIndex, text, failed: failedRecord }];
      updated.sort((a, b) => a.index - b.index);
    }
    const narration = { ...(scene.narration ?? { script: '' }), chunks: updated };
    return updateScene(current, sceneId, { narration });
  });
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
  llm: LlmClient | undefined,
  workspaceRoot: string,
  onProgress: (p: BatchProgress) => void,
  isCancelled: () => boolean = () => false,
): Promise<{ total: number; completed: number; failed: number; cancelled?: boolean }> {
  const { projectPath, sceneId, engine, voice, speed, expressiveness, selector = 'missing' } = input;

  const sb = await loadStoryboard(projectPath);
  if (!sb) throw new Error('No storyboard found');
  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);
  if (!scene.narration?.script) throw new Error('Scene has no script to narrate');

  const { derived, stored, targets } = planBatchNarration(scene, {
    engine,
    voice,
    speed,
    selector,
  });

  // Reconcile stored chunk gaps with the current script tokens BEFORE
  // generating. A token gap (>0) seeds/overrides; no token preserves any
  // UI-set gap. This is what applies a gap-only script edit (which doesn't
  // change chunk text, so isn't otherwise flagged stale) — and it does so
  // WITHOUT regenerating audio, per the spec's "gap ≠ TTS regen" guarantee.
  if (stored.length > 0) {
    await mutateStoryboard(projectPath, (current) => {
      if (!current) throw new Error('No storyboard found');
      const currentScene = current.scenes.find((candidate) => candidate.id === sceneId);
      if (!currentScene) throw new Error(`Scene not found: ${sceneId}`);
      const isDialog = (currentScene.narration?.mode ?? 'monologue') === 'dialog';
      const currentDerived = currentScene.narration?.script
        ? splitScriptIntoChunks(currentScene.narration.script, isDialog)
        : [];
      const synced = (currentScene.narration?.chunks ?? [])
        .filter((chunk) => chunk.index < currentDerived.length)
        .map((chunk) => {
          const tokenGap = currentDerived[chunk.index]?.gapSec ?? 0;
          return tokenGap > 0 && (chunk.gapSec ?? 0) !== tokenGap
            ? { ...chunk, gapSec: tokenGap }
            : chunk;
        });
      const activeMode = currentScene.narration?.mode ?? 'monologue';
      const modeChunksKey = activeMode === 'dialog' ? 'dialogChunks' : 'monologueChunks';
      const narration = {
        ...(currentScene.narration ?? { script: '' }),
        chunks: synced,
        [modeChunksKey]: synced,
      };
      return updateScene(current, sceneId, { narration });
    });
  }

  const total = targets.length;
  let completed = 0;
  let failedCount = 0;

  for (const target of targets) {
    const {
      index: i,
      text,
      engine: chunkEngine,
      voice: chunkVoice,
      speed: chunkSpeed,
      gapSec,
    } = target;
    if (isCancelled()) {
      onProgress({
        type: 'cancelled',
        total,
        completed,
        failed: failedCount,
        message: `Cancelled after ${completed} of ${total} chunks`,
      });
      return { total, completed, failed: failedCount, cancelled: true };
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
        // Only pass a token-seeded gap when the script actually has one (>0);
        // omitting it lets generateChunkNarration PRESERVE a manually-set
        // (UI) gap instead of an explicit 0 clobbering it.
        {
          projectPath,
          sceneId,
          chunkIndex: i,
          text,
          engine: chunkEngine,
          voice: chunkVoice,
          speed: chunkSpeed,
          expressiveness,
          gapSec: gapSec || undefined,
          replaceLegacyAudio: selector === 'all',
        },
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
      const reason = 'Narration generation failed';
      const errorName = err instanceof Error ? err.name : 'UnknownError';
      console.warn('[narration] chunk generation failed', { sceneId, chunkIndex: i, errorName });
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
