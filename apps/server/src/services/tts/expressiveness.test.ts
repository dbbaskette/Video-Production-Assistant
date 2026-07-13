import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import type { LlmClient } from '../llm/index.js';
import {
  geminiStyleDirective,
  stripAppEmotives,
  stripXaiTags,
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
});

describe('prepareExpressiveText', () => {
  it('runs the LLM insertion pass for xAI and returns the marked-up text', async () => {
    const llm = stubLlm('Hello <emphasis>world</emphasis>. [pause] Ready?');
    const out = await prepareExpressiveText({
      text: 'Hello world. Ready?',
      engine: 'xai',
      level: 'heavy',
      llm,
      workspaceRoot: workspaceRoot(),
    });
    expect(out).toContain('<emphasis>');
    expect(out).toContain('[pause]');
    expect(llm.complete).toHaveBeenCalledOnce();
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

  it('falls back to the original text when the xAI LLM pass throws', async () => {
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error('llm down');
      }),
    };
    const out = await prepareExpressiveText({
      text: 'Hello world.',
      engine: 'xai',
      level: 'medium',
      llm,
      workspaceRoot: workspaceRoot(),
    });
    expect(out).toBe('Hello world.');
  });
});
