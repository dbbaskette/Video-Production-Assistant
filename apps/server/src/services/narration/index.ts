import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TtsService } from '../tts/index.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../storyboard/index.js';
import { generateSrt, generateVtt } from './subtitles.js';

export interface NarrationInput {
  projectPath: string;
  sceneId: string;
  engine: string;
  voice: string;
  speed?: number;
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
 * Generate narration for the full script (legacy single-file mode).
 */
export async function generateNarration(
  input: NarrationInput,
  tts: TtsService,
): Promise<NarrationResult> {
  const { projectPath, sceneId, engine, voice, speed } = input;

  // Load storyboard and find scene
  const sb = await loadStoryboard(projectPath);
  if (!sb) throw new Error('No storyboard found');

  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);

  const script = scene.narration?.script;
  if (!script) throw new Error(`Scene ${sceneId} has no script. Generate a script first.`);

  // Check for unsupported emotive tags (non-blocking warning)
  const unsupportedEmotives = tts.checkEmotives(engine, script);

  // Generate audio via TTS
  const ttsResult = await tts.generate(engine, script, { voice, speed });

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
    tts: { engine, voice, speed: speed ?? 1.0 },
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
): Promise<ChunkNarrationResult> {
  const { projectPath, sceneId, chunkIndex, text, engine, voice, speed } = input;

  const sb = await loadStoryboard(projectPath);
  if (!sb) throw new Error('No storyboard found');

  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);

  const unsupportedEmotives = tts.checkEmotives(engine, text);

  // Generate audio for this chunk
  const ttsResult = await tts.generate(engine, text, { voice, speed });

  // Write chunk audio file
  const narrationDir = join(projectPath, 'narration');
  await mkdir(narrationDir, { recursive: true });

  const chunkTag = String(chunkIndex).padStart(2, '0');
  const audioRelPath = `narration/${sceneId}-chunk-${chunkTag}.mp3`;
  await writeFile(join(projectPath, audioRelPath), ttsResult.audio);

  // Update chunk in storyboard
  const existingChunks = scene.narration?.chunks ?? [];
  const newChunk = {
    index: chunkIndex,
    text,
    audio: audioRelPath,
    durationSec: ttsResult.durationSec,
    timings: ttsResult.timings ?? [],
  };

  // Replace existing chunk or append
  const chunkIdx = existingChunks.findIndex((c) => c.index === chunkIndex);
  const updatedChunks = [...existingChunks];
  if (chunkIdx >= 0) {
    updatedChunks[chunkIdx] = newChunk;
  } else {
    updatedChunks.push(newChunk);
    updatedChunks.sort((a, b) => a.index - b.index);
  }

  const narration = {
    ...(scene.narration ?? { script: text }),
    tts: { engine, voice, speed: speed ?? 1.0 },
    chunks: updatedChunks,
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
