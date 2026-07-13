import { describe, it, expect } from 'vitest';
import { polishScript } from './polish.js';
import type { LlmClient, LlmCompleteOptions } from '../llm/index.js';
import path from 'node:path';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../../..');
}

/**
 * Minimal LlmClient stub that returns a fixed response and records the
 * options it was called with. Lets each test control the model output
 * precisely (valid JSON, malformed, code-fenced) rather than depending on
 * the fake LLM's heuristics.
 */
function stubLlm(response: string) {
  const calls: LlmCompleteOptions[] = [];
  const llm: LlmClient = {
    async complete(opts) {
      calls.push(opts);
      return { text: response };
    },
  };
  return { llm, calls };
}

describe('polishScript', () => {
  it('parses a JSON { notes, script } response', async () => {
    const { llm } = stubLlm(
      JSON.stringify({
        notes: ['Tightened the opening', 'Added emotive tags'],
        script: '[warm] Welcome. [confident] Let us begin.',
      }),
    );

    const result = await polishScript(
      { draft: 'Welcome. Let us begin now.', sceneName: 'Intro' },
      llm,
      workspaceRoot(),
    );

    expect(result.proposedScript).toBe('[warm] Welcome. [confident] Let us begin.');
    expect(result.notes).toEqual(['Tightened the opening', 'Added emotive tags']);
    expect(result.currentWords).toBe(5); // "Welcome. Let us begin now."
    expect(result.proposedWords).toBe(6); // includes the two bracketed tags
  });

  it('falls back to raw text when the response is not JSON', async () => {
    const { llm } = stubLlm('[warm] Just some polished prose, not JSON.');

    const result = await polishScript({ draft: 'some prose' }, llm, workspaceRoot());

    expect(result.proposedScript).toBe('[warm] Just some polished prose, not JSON.');
    expect(result.notes).toEqual([]);
  });

  it('parses JSON wrapped in a markdown code fence', async () => {
    const { llm } = stubLlm('```json\n{"notes":["a"],"script":"[warm] Hi there."}\n```');

    const result = await polishScript({ draft: 'hi' }, llm, workspaceRoot());

    expect(result.proposedScript).toBe('[warm] Hi there.');
    expect(result.notes).toEqual(['a']);
  });

  it('computes targetWords from duration and wpm when a duration is provided', async () => {
    const { llm } = stubLlm(JSON.stringify({ notes: [], script: 'x' }));

    const result = await polishScript(
      { draft: 'draft', targetDurationSec: 60, wpm: 150 },
      llm,
      workspaceRoot(),
    );

    expect(result.targetWords).toBe(150);
  });

  it('omits targetWords when no duration is provided', async () => {
    const { llm } = stubLlm(JSON.stringify({ notes: [], script: 'x' }));

    const result = await polishScript({ draft: 'draft' }, llm, workspaceRoot());

    expect(result.targetWords).toBeUndefined();
  });

  it('sends the draft and the polish system prompt to the LLM', async () => {
    const { llm, calls } = stubLlm(JSON.stringify({ notes: [], script: 'x' }));

    await polishScript({ draft: 'my unique draft text', sceneName: 'S' }, llm, workspaceRoot());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.userPrompt).toContain('my unique draft text');
    // The polish prompt identifies itself so humans (and the fake LLM) can
    // tell it apart from the write-from-scratch narration prompt.
    expect(calls[0]!.systemPrompt.toLowerCase()).toContain('polish');
  });
});
