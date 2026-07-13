import { describe, it, expect } from 'vitest';
import { parsePauses, stripTimedPauseTokens } from './pause-parser.js';

describe('parsePauses', () => {
  it('returns a single gapless segment for text with no tokens', () => {
    expect(parsePauses('Hello world.')).toEqual([{ text: 'Hello world.', gapSec: 0 }]);
  });

  it('splits on a [pause Xs] token, setting the gap on the preceding segment', () => {
    expect(parsePauses('First line. [pause 1.5s] Second line.')).toEqual([
      { text: 'First line.', gapSec: 1.5 },
      { text: 'Second line.', gapSec: 0 },
    ]);
  });

  it('accepts a bare number and a number with a space before s', () => {
    expect(parsePauses('A [pause 2] B [pause 0.8 s] C')).toEqual([
      { text: 'A', gapSec: 2 },
      { text: 'B', gapSec: 0.8 },
      { text: 'C', gapSec: 0 },
    ]);
  });

  it('strips the token from the emitted text', () => {
    const out = parsePauses('Watch this [pause 1s] closely.');
    expect(out.map((s) => s.text).join(' ')).not.toContain('[pause');
  });

  it('clamps out-of-range durations to 0.1–10s', () => {
    expect(parsePauses('a [pause 99s] b')[0]!.gapSec).toBe(10);
    expect(parsePauses('a [pause 0.01s] b')[0]!.gapSec).toBe(0.1);
  });

  it('strips a non-numeric [pause abc] and contributes no gap', () => {
    expect(parsePauses('a [pause abc] b')).toEqual([{ text: 'a b', gapSec: 0 }]);
  });

  it('leaves a bare [pause] untouched for the xAI expressive path', () => {
    expect(parsePauses('a [pause] b')).toEqual([{ text: 'a [pause] b', gapSec: 0 }]);
  });

  it('folds consecutive tokens into one combined gap', () => {
    expect(parsePauses('a [pause 1s] [pause 1s] b')).toEqual([
      { text: 'a', gapSec: 2 },
      { text: 'b', gapSec: 0 },
    ]);
  });

  it('drops a leading token (no silence before any speech)', () => {
    expect(parsePauses('[pause 2s] Hello.')).toEqual([{ text: 'Hello.', gapSec: 0 }]);
  });

  it('stripTimedPauseTokens removes timed tokens but keeps a bare [pause]', () => {
    expect(stripTimedPauseTokens('Say [pause 1.5s] this and [pause] that.')).toBe(
      'Say this and [pause] that.',
    );
  });

  it('accepts an uppercase S suffix', () => {
    expect(parsePauses('a [pause 1.5S] b')[0]!.gapSec).toBe(1.5);
  });

  it('drops a trailing token gap (no silence after the last words in the segment list)', () => {
    // A trailing pause has nothing after it — it still attaches to the last
    // segment as its trailing gap so an inter-paragraph pause at the very end
    // of one paragraph is preserved.
    expect(parsePauses('Hello. [pause 1.5s]')).toEqual([{ text: 'Hello.', gapSec: 1.5 }]);
  });
});
