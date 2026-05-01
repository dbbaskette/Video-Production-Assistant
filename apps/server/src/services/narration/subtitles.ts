export interface SubtitleTiming {
  word: string;
  t: number;
}

export interface SubtitleOpts {
  maxWordsPerCue?: number; // default 8
}

/** Strip emotive tags like [warm] from display text. */
function stripEmotiveTags(text: string): string {
  return text.replace(/\[[\w-]+\]/g, '').trim();
}

interface Cue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

/** Group word timings into subtitle cues. */
function buildCues(timings: SubtitleTiming[], opts?: SubtitleOpts): Cue[] {
  if (timings.length === 0) return [];

  const maxWords = opts?.maxWordsPerCue ?? 8;
  const cues: Cue[] = [];
  let cueWords: SubtitleTiming[] = [];
  let cueIndex = 1;

  for (let i = 0; i < timings.length; i++) {
    cueWords.push(timings[i]!);

    const isLastWord = i === timings.length - 1;
    const cueIsFull = cueWords.length >= maxWords;

    if (isLastWord || cueIsFull) {
      const startSec = cueWords[0]!.t;
      // End time: start of next word, or last word + 1 second
      const endSec = isLastWord
        ? cueWords[cueWords.length - 1]!.t + 1.0
        : timings[i + 1]!.t;

      const text = stripEmotiveTags(
        cueWords.map((w) => w.word).join(' '),
      );

      if (text.length > 0) {
        cues.push({ index: cueIndex++, startSec, endSec, text });
      }

      cueWords = [];
    }
  }

  return cues;
}

/** Format seconds as SRT timestamp: HH:MM:SS,mmm */
function formatSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(s).padStart(2, '0') +
    ',' +
    String(ms).padStart(3, '0')
  );
}

/** Format seconds as VTT timestamp: HH:MM:SS.mmm */
function formatVttTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(s).padStart(2, '0') +
    '.' +
    String(ms).padStart(3, '0')
  );
}

/** Generate SRT subtitle text from word-level timings. */
export function generateSrt(timings: SubtitleTiming[], opts?: SubtitleOpts): string {
  const cues = buildCues(timings, opts);
  if (cues.length === 0) return '';

  return cues
    .map(
      (cue) =>
        `${cue.index}\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\n${cue.text}`,
    )
    .join('\n\n') + '\n';
}

/** Generate WebVTT subtitle text from word-level timings. */
export function generateVtt(timings: SubtitleTiming[], opts?: SubtitleOpts): string {
  const cues = buildCues(timings, opts);
  if (cues.length === 0) return 'WEBVTT\n';

  const cueText = cues
    .map(
      (cue) =>
        `${formatVttTime(cue.startSec)} --> ${formatVttTime(cue.endSec)}\n${cue.text}`,
    )
    .join('\n\n');

  return `WEBVTT\n\n${cueText}\n`;
}
