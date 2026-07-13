import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TtsService } from '../tts/index.js';
import type { LlmClient } from '../llm/index.js';
import type { Expressiveness } from '@vpa/shared';
import { prepareExpressiveText } from '../tts/expressiveness.js';
import { parsePauses, stripTimedPauseTokens } from './pause-parser.js';
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
  /** Trailing silence after this chunk. When omitted, the chunk's existing
   *  gap is preserved (a single-chunk regen shouldn't drop a set pause). */
  gapSec?: number;
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
  llm: LlmClient,
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
    llm,
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
  llm: LlmClient,
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
  // Seed gap from the request (script-derived); otherwise preserve any existing
  // gap so a single-chunk regen doesn't wipe a set pause.
  const gapSec = input.gapSec ?? (chunkIdx >= 0 ? existingChunks[chunkIdx]!.gapSec : undefined) ?? 0;

  const newChunk = {
    index: chunkIndex,
    text,
    audio: audioRelPath,
    durationSec: ttsResult.durationSec,
    timings: ttsResult.timings ?? [],
    ...(gapSec > 0 ? { gapSec } : {}),
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
    const derived = scene.narration?.script
      ? splitScriptIntoChunks(scene.narration.script, isDialog)
      : [];
    const text = derived[chunkIndex]?.text ?? '';
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
  // Pause-aware chunks: each carries its text (pause tokens stripped) + gapSec.
  const derived = splitScriptIntoChunks(scene.narration.script, isDialog);
  const paragraphs = derived.map((d) => d.text);

  const stored = scene.narration.chunks ?? [];

  // Reconcile stored chunk gaps with the current script tokens BEFORE
  // generating. A token gap (>0) seeds/overrides; no token preserves any
  // UI-set gap. This is what applies a gap-only script edit (which doesn't
  // change chunk text, so isn't otherwise flagged stale) — and it does so
  // WITHOUT regenerating audio, per the spec's "gap ≠ TTS regen" guarantee.
  {
    let gapsChanged = false;
    const synced = stored.map((c) => {
      const tokenGap = derived[c.index]?.gapSec ?? 0;
      if (tokenGap > 0 && (c.gapSec ?? 0) !== tokenGap) {
        gapsChanged = true;
        return { ...c, gapSec: tokenGap };
      }
      return c;
    });
    if (gapsChanged) {
      const narration = { ...(scene.narration ?? {}), chunks: synced };
      await saveStoryboard(projectPath, updateScene(sb, sceneId, { narration: narration as any }));
    }
  }

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
        // Only pass a token-seeded gap when the script actually has one (>0);
        // omitting it lets generateChunkNarration PRESERVE a manually-set
        // (UI) gap instead of an explicit 0 clobbering it.
        { projectPath, sceneId, chunkIndex: i, text, engine: chunkEngine, voice: chunkVoice, speed: chunkSpeed, expressiveness, gapSec: derived[i]?.gapSec || undefined },
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
