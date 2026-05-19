import { describe, it, expect } from 'vitest';
import { parseJsonBlock } from './parse-json-block.js';

describe('parseJsonBlock', () => {
  it('returns the parsed object from a fenced ```json block', () => {
    const text = 'preamble\n```json\n{"a":1}\n```\nepilogue';
    expect(parseJsonBlock<{ a: number }>(text)).toEqual({ a: 1 });
  });

  it('returns null when there is no fenced block', () => {
    expect(parseJsonBlock('plain text')).toBeNull();
  });

  it('returns null for malformed JSON inside the block', () => {
    expect(parseJsonBlock('```json\n{not valid\n```')).toBeNull();
  });

  it('returns the first match when multiple blocks are present', () => {
    const text = '```json\n{"first":true}\n```\nthen\n```json\n{"second":true}\n```';
    expect(parseJsonBlock<{ first: boolean }>(text)).toEqual({ first: true });
  });
});
