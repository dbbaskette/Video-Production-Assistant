/**
 * Trim a too-long voice-clone reference down to ~targetSec while keeping the
 * transcript roughly in sync.
 *
 * Audio: ffmpeg silencedetect → pick the silence point nearest the target,
 * then re-encode to canonical 24 kHz mono 16-bit PCM.
 *
 * Transcript: char-ratio estimate (cutSec / fullSec) snapped to the nearest
 * sentence boundary. Imprecise by design — --ref_text is a hint, not a
 * hard constraint, so close-enough is fine.
 *
 * The original audio.wav becomes audio.full.wav (and transcript.txt becomes
 * transcript.full.txt) on first trim, so the original is always recoverable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const runFfmpeg = promisify(execFile);

export interface TrimResult {
  trimmedDurationSec: number;
  originalDurationSec: number;
  /** True if a transcript was trimmed alongside the audio. */
  transcriptTrimmed: boolean;
}

const SILENCE_DB = -30;
const SILENCE_MIN_DUR = 0.3;
/** Search window around targetSec for a silence point: [-2, +5]. */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 5;

/**
 * Trim a voice clone in place. Returns the new durations, or throws if the
 * input is shorter than target (caller should just skip).
 */
export async function trimVoiceClone(
  voiceDir: string,
  targetSec: number,
): Promise<TrimResult> {
  const audioPath = join(voiceDir, 'audio.wav');
  const fullAudioPath = join(voiceDir, 'audio.full.wav');
  const transcriptPath = join(voiceDir, 'transcript.txt');
  const fullTranscriptPath = join(voiceDir, 'transcript.full.txt');

  // If a backup already exists from a prior trim, work from that — re-trimming
  // a trimmed file would compound silence cuts.
  const haveBackup = await stat(fullAudioPath).catch(() => null);
  const sourceAudio = haveBackup ? fullAudioPath : audioPath;

  const originalDurationSec = await probeDurationSec(sourceAudio);
  if (originalDurationSec <= targetSec) {
    throw new Error(`Audio is already ${originalDurationSec.toFixed(1)}s; nothing to trim.`);
  }

  const cutSec = await pickCutPoint(sourceAudio, targetSec);

  // Cut audio: re-encode to canonical 24 kHz mono 16-bit PCM, with a 50ms
  // fade-out so cuts in the middle of breath/word are softer.
  const work = join(tmpdir(), `vpa-trim-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  const outPath = join(work, 'out.wav');
  try {
    const fadeStart = Math.max(0, cutSec - 0.05);
    await runFfmpeg('ffmpeg', [
      '-y',
      '-i', sourceAudio,
      '-t', cutSec.toFixed(3),
      '-af', `afade=t=out:st=${fadeStart.toFixed(3)}:d=0.05`,
      '-ac', '1',
      '-ar', '24000',
      '-acodec', 'pcm_s16le',
      outPath,
    ]);

    // Backup original if not already backed up, then swap in the trim.
    if (!haveBackup) {
      await rename(audioPath, fullAudioPath);
    }
    const trimmed = await readFile(outPath);
    await writeFile(audioPath, trimmed);
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  // Trim transcript by char-ratio + sentence-boundary snap.
  let transcriptTrimmed = false;
  const transcript = await readFile(transcriptPath, 'utf-8').catch(() => null);
  if (transcript && transcript.trim().length > 0) {
    const ratio = cutSec / originalDurationSec;
    const trimmedText = trimTranscriptByRatio(transcript, ratio);
    // Only backup on first trim; preserve the user's original.
    const haveTranscriptBackup = await stat(fullTranscriptPath).catch(() => null);
    if (!haveTranscriptBackup) {
      await rename(transcriptPath, fullTranscriptPath);
    }
    await writeFile(transcriptPath, trimmedText, 'utf-8');
    transcriptTrimmed = true;
  }

  const trimmedDurationSec = await probeDurationSec(audioPath);
  return { trimmedDurationSec, originalDurationSec, transcriptTrimmed };
}

/**
 * Restore the original audio (and transcript) from the .full.* backups.
 * No-op if no backup exists.
 */
export async function restoreOriginal(voiceDir: string): Promise<boolean> {
  const audioPath = join(voiceDir, 'audio.wav');
  const fullAudioPath = join(voiceDir, 'audio.full.wav');
  const transcriptPath = join(voiceDir, 'transcript.txt');
  const fullTranscriptPath = join(voiceDir, 'transcript.full.txt');

  const haveBackup = await stat(fullAudioPath).catch(() => null);
  if (!haveBackup) return false;

  await rm(audioPath, { force: true });
  await rename(fullAudioPath, audioPath);

  const haveTranscriptBackup = await stat(fullTranscriptPath).catch(() => null);
  if (haveTranscriptBackup) {
    await rm(transcriptPath, { force: true });
    await rename(fullTranscriptPath, transcriptPath);
  }
  return true;
}

/**
 * Pick the best cut point near targetSec by looking for silence regions in the
 * window [target - WINDOW_BEFORE, target + WINDOW_AFTER]. Falls back to
 * targetSec if no silence point is found.
 */
async function pickCutPoint(audioPath: string, targetSec: number): Promise<number> {
  const minWindow = Math.max(1, targetSec - WINDOW_BEFORE);
  const maxWindow = targetSec + WINDOW_AFTER;
  let stderr = '';
  try {
    const res = await runFfmpeg('ffmpeg', [
      '-hide_banner',
      '-i', audioPath,
      '-af', `silencedetect=noise=${SILENCE_DB}dB:duration=${SILENCE_MIN_DUR}`,
      '-f', 'null', '-',
    ]);
    stderr = res.stderr;
  } catch (err) {
    // ffmpeg writes to stderr even on success; some versions return non-zero.
    stderr = (err as { stderr?: string }).stderr ?? '';
  }
  const candidates: number[] = [];
  // Lines look like:  [silencedetect @ 0x...] silence_end: 12.345 | silence_duration: 0.512
  for (const line of stderr.split('\n')) {
    const m = line.match(/silence_end:\s*([0-9.]+)/);
    if (!m) continue;
    const t = parseFloat(m[1]!);
    if (Number.isFinite(t) && t >= minWindow && t <= maxWindow) {
      candidates.push(t);
    }
  }
  if (candidates.length === 0) return targetSec;
  let best = candidates[0]!;
  let bestDiff = Math.abs(best - targetSec);
  for (const c of candidates) {
    const d = Math.abs(c - targetSec);
    if (d < bestDiff) {
      best = c;
      bestDiff = d;
    }
  }
  return best;
}

async function probeDurationSec(path: string): Promise<number> {
  const { stdout } = await runFfmpeg('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const dur = parseFloat(stdout.trim());
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error('Could not probe audio duration');
  }
  return dur;
}

/**
 * Cut transcript at approximately (ratio * length) characters, then snap to
 * the nearest sentence boundary within a small window. Exposed for tests.
 */
export function trimTranscriptByRatio(transcript: string, ratio: number): string {
  if (ratio >= 1) return transcript;
  if (ratio <= 0) return '';
  const target = Math.round(transcript.length * ratio);
  const snapped = snapToSentenceBoundary(transcript, target);
  return transcript.slice(0, snapped).trim();
}

/**
 * Walk outward from `pos` looking for ". ", "! ", "? ", or "\n\n". Returns
 * the index just after the punctuation. Falls back to `pos` if no boundary
 * is within SNAP_RADIUS.
 */
function snapToSentenceBoundary(text: string, pos: number): number {
  const SNAP_RADIUS = 80;
  const lo = Math.max(0, pos - SNAP_RADIUS);
  const hi = Math.min(text.length, pos + SNAP_RADIUS);
  const window = text.slice(lo, hi);
  const re = /([.!?]["')\]]?\s+|\n{2,})/g;
  let best = -1;
  let bestDist = Infinity;
  let m;
  while ((m = re.exec(window)) !== null) {
    const abs = lo + m.index + m[0].length;
    const d = Math.abs(abs - pos);
    if (d < bestDist) {
      best = abs;
      bestDist = d;
    }
  }
  return best === -1 ? pos : best;
}
