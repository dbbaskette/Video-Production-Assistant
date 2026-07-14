import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import type { LlmClient } from '../llm/index.js';
import {
  geminiStyleDirective,
  stripAppEmotives,
  stripXaiTags,
  keepAllowedXaiTags,
  ensureLeadingWord,
  prepareExpressiveText,
} from './expressiveness.js';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../../..');
}

function stubLlm(text: string): LlmClient {
  return { complete: vi.fn(async () => ({ text })) };
}

describe('geminiStyleDirective', () => {
  it('returns a distinct directive per level', () => {
    const light = geminiStyleDirective('light');
    const medium = geminiStyleDirective('medium');
    const heavy = geminiStyleDirective('heavy');
    expect(light).toMatch(/light/i);
    expect(medium.length).toBeGreaterThan(0);
    expect(heavy).toMatch(/strong|animated|emotion/i);
    // The three levels must not collapse to the same string.
    expect(new Set([light, medium, heavy]).size).toBe(3);
  });
});

describe('stripAppEmotives', () => {
  it("removes the app's emotive words", () => {
    expect(stripAppEmotives('[warm] Hello [confident] world.')).toBe('Hello world.');
  });

  it('preserves xAI inline and wrapping tags', () => {
    const input = '[pause] Notice <emphasis>this</emphasis> [inhale] and <soft>that</soft>.';
    expect(stripAppEmotives(input)).toBe(input);
  });

  it('strips app emotives but keeps neighbouring xAI tags', () => {
    expect(stripAppEmotives('[excited] Look [pause] here <strong>now</strong>.')).toBe(
      'Look [pause] here <strong>now</strong>.',
    );
  });
});

describe('stripXaiTags', () => {
  it('removes inline and wrapping xAI tags, leaving only spoken words', () => {
    const input = 'Notice <emphasis>this feature</emphasis>. [pause] It just <soft>works</soft>.';
    expect(stripXaiTags(input)).toBe('Notice this feature. It just works.');
  });

  it('leaves untagged text intact', () => {
    expect(stripXaiTags('Plain narration here.')).toBe('Plain narration here.');
  });

  it('strips wrapping tags even when they carry stray attributes', () => {
    expect(stripXaiTags('<slow rate="0.8">this</slow> [long-pause] now.')).toBe('this now.');
  });
});

describe('keepAllowedXaiTags', () => {
  it('keeps documented xAI tags and removes non-documented ones (keeping inner text)', () => {
    expect(
      keepAllowedXaiTags('<slow>Watch this</slow> [pause] <emphasis>closely</emphasis> [laugh] now.'),
    ).toBe('<slow>Watch this</slow> [pause] closely now.');
  });

  it('keeps [long-pause] and drops <strong>', () => {
    expect(keepAllowedXaiTags('A [long-pause] <strong>B</strong>.')).toBe('A [long-pause] B.');
  });
});

describe('ensureLeadingWord', () => {
  it('drops a leading open wrapping tag AND its matching close so a word comes first', () => {
    expect(ensureLeadingWord('<slow>Watch this</slow> [pause] more.')).toBe('Watch this [pause] more.');
  });

  it('drops a leading inline tag', () => {
    expect(ensureLeadingWord('[pause] Hello there.')).toBe('Hello there.');
  });

  it('leaves already-word-first text untouched', () => {
    expect(ensureLeadingWord('Hello <slow>world</slow>.')).toBe('Hello <slow>world</slow>.');
  });
});

describe('prepareExpressiveText', () => {
  it('never returns text that starts with a tag (xAI framing guard)', async () => {
    const llm = stubLlm('<slow>Hello world.</slow> [pause] Ready?');
    const out = await prepareExpressiveText({
      text: 'Hello world. Ready?',
      engine: 'xai',
      level: 'heavy',
      llm,
      workspaceRoot: workspaceRoot(),
    });
    expect(out.startsWith('<') || out.startsWith('[')).toBe(false);
    expect(out).toMatch(/^Hello/);
  });

  it('strips a non-documented tag the model slipped in, keeping documented ones', async () => {
    const llm = stubLlm('Hello <emphasis>world</emphasis>. [pause] <slow>Ready?</slow>');
    const out = await prepareExpressiveText({
      text: 'Hello world. Ready?',
      engine: 'xai',
      level: 'heavy',
      llm,
      workspaceRoot: workspaceRoot(),
    });
    expect(out).not.toContain('<emphasis>');
    expect(out).toContain('[pause]');
    expect(out).toContain('<slow>');
  });

  // xAI's /v1/tts HONORS its tags (verified via STT), so for xAI we DO insert
  // them via an LLM pass — but we must guard against a weak/local model adding
  // stray WORDS (which xAI would then speak).
  it('inserts xAI tags for xAI when the model only added markup (words unchanged)', async () => {
    const llm = stubLlm('Hello <slow>world</slow>. [pause] Ready?');
    const out = await prepareExpressiveText({
      text: 'Hello world. Ready?',
      engine: 'xai',
      level: 'heavy',
      llm,
      workspaceRoot: workspaceRoot(),
    });
    expect(out).toContain('<slow>');
    expect(out).toContain('[pause]');
    expect(llm.complete).toHaveBeenCalledOnce();
  });

  it('falls back to CLEAN text when the xAI pass adds/changes words (never lets stray words reach TTS)', async () => {
    // A weaker model prepends a preamble — the classic "words not in the script".
    const llm = stubLlm('Sure! Here you go: Hello <slow>world</slow>. Ready?');
    const out = await prepareExpressiveText({
      text: 'Hello world. Ready?',
      engine: 'xai',
      level: 'heavy',
      llm,
      workspaceRoot: workspaceRoot(),
    });
    expect(out).toBe('Hello world. Ready?'); // guard rejected the tampered output
  });

  it('falls back to clean text when the xAI LLM pass throws', async () => {
    const llm: LlmClient = { complete: vi.fn(async () => { throw new Error('llm down'); }) };
    const out = await prepareExpressiveText({
      text: '[warm] Hello world.',
      engine: 'xai',
      level: 'medium',
      llm,
      workspaceRoot: workspaceRoot(),
    });
    expect(out).toBe('Hello world.'); // app emotive stripped, no tags
  });

  it('leaves text unchanged for non-xAI engines and never calls the LLM', async () => {
    const llm = stubLlm('SHOULD-NOT-BE-USED');
    const out = await prepareExpressiveText({
      text: '[warm] Hello world.',
      engine: 'gemini',
      level: 'heavy',
      llm,
      workspaceRoot: workspaceRoot(),
    });
    expect(out).toBe('[warm] Hello world.');
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
