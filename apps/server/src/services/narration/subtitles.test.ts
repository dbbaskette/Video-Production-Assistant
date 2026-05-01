import { describe, it, expect } from 'vitest';
import { generateSrt, generateVtt } from './subtitles.js';
import type { SubtitleTiming } from './subtitles.js';

const SAMPLE_TIMINGS: SubtitleTiming[] = [
  { word: "Let's", t: 0.0 },
  { word: 'take', t: 0.21 },
  { word: 'a', t: 0.35 },
  { word: 'look', t: 0.42 },
  { word: 'at', t: 0.58 },
  { word: 'this', t: 0.71 },
  { word: 'demo.', t: 0.89 },
  { word: 'Notice', t: 1.2 },
  { word: 'how', t: 1.45 },
  { word: 'we', t: 1.6 },
  { word: 'walk', t: 1.75 },
  { word: 'through', t: 1.92 },
  { word: 'each', t: 2.1 },
  { word: 'step', t: 2.28 },
  { word: 'carefully.', t: 2.5 },
];

describe('generateSrt', () => {
  it('produces valid SRT with cue numbers', () => {
    const srt = generateSrt(SAMPLE_TIMINGS);
    expect(srt).toContain('1\n');
    expect(srt).toContain('-->');
    expect(srt).toContain("Let's take a look at this demo. Notice");
    // SRT uses comma in timestamps
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
  });

  it('groups words into cues respecting maxWordsPerCue', () => {
    const srt = generateSrt(SAMPLE_TIMINGS, { maxWordsPerCue: 4 });
    // With 15 words at 4 per cue: 4 cues
    const cueCount = (srt.match(/\n\d+\n/g) || []).length + 1; // +1 for first cue at start
    expect(cueCount).toBeGreaterThanOrEqual(3);
  });

  it('returns empty string for no timings', () => {
    expect(generateSrt([])).toBe('');
  });

  it('handles single word', () => {
    const srt = generateSrt([{ word: 'Hello', t: 0.0 }]);
    expect(srt).toContain('Hello');
    expect(srt).toContain('00:00:00,000 --> 00:00:01,000');
  });

  it('strips emotive tags from display text', () => {
    const timings: SubtitleTiming[] = [
      { word: '[warm]', t: 0.0 },
      { word: 'Hello', t: 0.3 },
      { word: 'world.', t: 0.6 },
    ];
    const srt = generateSrt(timings);
    expect(srt).not.toContain('[warm]');
    expect(srt).toContain('Hello world.');
  });
});

describe('generateVtt', () => {
  it('starts with WEBVTT header', () => {
    const vtt = generateVtt(SAMPLE_TIMINGS);
    expect(vtt).toMatch(/^WEBVTT\n/);
  });

  it('uses dot in timestamps (not comma)', () => {
    const vtt = generateVtt(SAMPLE_TIMINGS);
    expect(vtt).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    expect(vtt).not.toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
  });

  it('returns just header for no timings', () => {
    expect(generateVtt([])).toBe('WEBVTT\n');
  });

  it('strips emotive tags from display text', () => {
    const timings: SubtitleTiming[] = [
      { word: '[confident]', t: 0.0 },
      { word: 'This', t: 0.2 },
      { word: 'matters.', t: 0.5 },
    ];
    const vtt = generateVtt(timings);
    expect(vtt).not.toContain('[confident]');
    expect(vtt).toContain('This matters.');
  });
});
