import { describe, it, expect } from 'vitest';
import {
  parseStepsFromResponse,
  ShotPlanSession,
  ShotPlanManager,
  stripJsonBlock,
} from './index.js';
import type { LlmClient } from '../llm/index.js';

describe('parseStepsFromResponse', () => {
  it('extracts steps from a fenced JSON block', () => {
    const text =
      'Here is the plan:\n\n```json\n{"steps": [' +
      '{"index": 1, "action": "Open Terminal"},' +
      '{"index": 2, "action": "Type `npm run dev`", "note": "wait"}' +
      ']}\n```';
    const steps = parseStepsFromResponse(text);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ index: 1, action: 'Open Terminal' });
    expect(steps[1]).toEqual({ index: 2, action: 'Type `npm run dev`', note: 'wait' });
  });

  it('returns empty array when no JSON block is present', () => {
    expect(parseStepsFromResponse('just prose, no fence')).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseStepsFromResponse('```json\n{nope\n```')).toEqual([]);
  });

  it('drops steps with empty action', () => {
    const text = '```json\n{"steps":[{"index":1,"action":""},{"index":2,"action":"OK"}]}\n```';
    const steps = parseStepsFromResponse(text);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.action).toBe('OK');
  });

  it('coerces missing index to 0-based ordinal', () => {
    const text = '```json\n{"steps":[{"action":"A"},{"action":"B"}]}\n```';
    const steps = parseStepsFromResponse(text);
    expect(steps).toEqual([
      { index: 1, action: 'A' },
      { index: 2, action: 'B' },
    ]);
  });

  it('returns empty array when JSON block has no steps key', () => {
    const text = '```json\n{"plan":[{"action":"X"}]}\n```';
    expect(parseStepsFromResponse(text)).toEqual([]);
  });
});

describe('stripJsonBlock', () => {
  it('removes the fenced block from the assistant text', () => {
    const text = 'hello\n```json\n{"x":1}\n```\nworld';
    expect(stripJsonBlock(text)).toBe('hello\n\nworld');
  });

  it('returns text unchanged when no block is present', () => {
    expect(stripJsonBlock('plain text')).toBe('plain text');
  });
});

describe('ShotPlanSession (state only)', () => {
  it('starts empty', () => {
    const s = new ShotPlanSession('p1', 'scene-01');
    expect(s.transcript).toEqual([]);
    expect(s.proposedSteps).toEqual([]);
  });

  it('hydrates transcript from a saved chat', () => {
    const s = new ShotPlanSession('p1', 'scene-01', [
      { role: 'user', content: 'hi', at: '2026-05-19T12:00:00.000Z' },
      { role: 'assistant', content: 'ok', at: '2026-05-19T12:00:01.000Z' },
    ]);
    expect(s.transcript).toHaveLength(2);
  });
});

describe('ShotPlanSession.appendTurn', () => {
  it('returns a turn with the given role and content and a valid ISO timestamp', () => {
    const s = new ShotPlanSession('p1', 'scene-01');
    const turn = s.appendTurn('user', 'Plan it');
    expect(turn.role).toBe('user');
    expect(turn.content).toBe('Plan it');
    // ISO 8601 datetime, e.g. 2026-05-19T12:00:00.000Z
    expect(turn.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
  });

  it('appends the turn to the session transcript', () => {
    const s = new ShotPlanSession('p1', 'scene-01');
    s.appendTurn('user', 'hi');
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]?.content).toBe('hi');
  });

  it('accumulates sequential turns in order', () => {
    const s = new ShotPlanSession('p1', 'scene-01');
    s.appendTurn('user', 'first');
    s.appendTurn('assistant', 'second');
    s.appendTurn('user', 'third');
    expect(s.transcript.map((t) => `${t.role}:${t.content}`)).toEqual([
      'user:first',
      'assistant:second',
      'user:third',
    ]);
  });
});

describe('ShotPlanManager', () => {
  it('getOrCreate returns the same session for the same (project, scene)', () => {
    const m = new ShotPlanManager();
    const a = m.getOrCreate('p1', 'scene-01');
    const b = m.getOrCreate('p1', 'scene-01');
    expect(a).toBe(b);
  });

  it('getOrCreate returns different sessions for different scenes', () => {
    const m = new ShotPlanManager();
    const a = m.getOrCreate('p1', 'scene-01');
    const b = m.getOrCreate('p1', 'scene-02');
    expect(a).not.toBe(b);
  });

  it('get returns undefined when no session exists', () => {
    const m = new ShotPlanManager();
    expect(m.get('p1', 'scene-01')).toBeUndefined();
  });

  it('delete removes the session', () => {
    const m = new ShotPlanManager();
    m.getOrCreate('p1', 'scene-01');
    m.delete('p1', 'scene-01');
    expect(m.get('p1', 'scene-01')).toBeUndefined();
  });

  it('getOrCreate hydrates from a passed transcript only on first creation', () => {
    const m = new ShotPlanManager();
    const a = m.getOrCreate('p1', 'scene-01', [
      { role: 'user', content: 'first', at: '2026-05-19T12:00:00.000Z' },
    ]);
    expect(a.transcript).toHaveLength(1);
    // second call with a different transcript should not overwrite the existing session
    const b = m.getOrCreate('p1', 'scene-01', [
      { role: 'user', content: 'overwrite?', at: '2026-05-19T12:00:02.000Z' },
    ]);
    expect(b).toBe(a);
    expect(b.transcript).toHaveLength(1);
    expect(b.transcript[0]?.content).toBe('first');
  });
});

const MOCK_LLM_TEXT =
  'Here is the plan:\n\n```json\n{"steps":[' +
  '{"index":1,"action":"Open Terminal"},' +
  '{"index":2,"action":"Type `npm run dev`","note":"wait"}' +
  ']}\n```\n\nAnything missing?';

const mockLlm: LlmClient = {
  async complete() {
    return { text: MOCK_LLM_TEXT };
  },
};

describe('ShotPlanSession.sendMessage', () => {
  it('appends user + assistant turns and updates proposedSteps', async () => {
    const s = new ShotPlanSession('p1', 'scene-01');
    const scene = {
      id: 'scene-01',
      name: 'Boot the dev server',
      description: 'Show the dev server starting',
      type: 'terminal' as const,
    };
    const project = { objective: 'Show how to run the app', audience: 'developers' };

    const reply = await s.sendMessage('Plan it', mockLlm, scene, project);

    expect(s.transcript).toHaveLength(2);
    expect(s.transcript[0]?.role).toBe('user');
    expect(s.transcript[0]?.content).toBe('Plan it');
    expect(s.transcript[1]?.role).toBe('assistant');

    expect(reply.role).toBe('assistant');
    expect(reply.content).not.toContain('```json');
    expect(reply.content).toContain('Anything missing?');

    expect(s.proposedSteps).toHaveLength(2);
    expect(s.proposedSteps[0]?.action).toBe('Open Terminal');
  });

  it('passes scene + project context into the LLM prompt', async () => {
    let captured = '';
    const captureLlm: LlmClient = {
      async complete(opts) {
        expect(opts.temperature).toBe(0.4);
        captured = `${opts.systemPrompt}\n---\n${opts.userPrompt}`;
        return { text: MOCK_LLM_TEXT };
      },
    };
    const s = new ShotPlanSession('p1', 'scene-01');
    const scene = {
      id: 'scene-01',
      name: 'Boot the dev server',
      description: 'Show the dev server starting',
      intent: 'demonstrate hot reload',
      type: 'terminal' as const,
    };
    const project = { objective: 'Show how to run the app', audience: 'developers' };

    await s.sendMessage('Plan it', captureLlm, scene, project);

    expect(captured).toContain('Shot Plan author');
    expect(captured).toContain('Boot the dev server');
    expect(captured).toContain('Show the dev server starting');
    expect(captured).toContain('demonstrate hot reload');
    expect(captured).toContain('Show how to run the app');
    expect(captured).toContain('developers');
  });

  it('leaves proposedSteps unchanged when the response has no JSON block', async () => {
    const noJsonLlm: LlmClient = {
      async complete() {
        return { text: 'just prose, no fence here' };
      },
    };
    const s = new ShotPlanSession('p1', 'scene-01');
    const scene = { id: 'scene-01', name: 'X', description: 'y', type: 'desktop' as const };

    await s.sendMessage('hi', noJsonLlm, scene, {});
    expect(s.proposedSteps).toEqual([]);
    expect(s.transcript).toHaveLength(2);
    expect(s.transcript[1]?.content).toBe('just prose, no fence here');
  });

  it('includes sibling scenes in the prompt with a CURRENT SCENE marker', async () => {
    let captured = '';
    const captureLlm: LlmClient = {
      async complete(opts) {
        captured = opts.userPrompt;
        return { text: MOCK_LLM_TEXT };
      },
    };
    const s = new ShotPlanSession('p1', 'scene-02');
    const scene = {
      id: 'scene-02',
      name: 'Orienting to the Data',
      description: 'Show the schema',
      type: 'desktop' as const,
    };
    const siblings = [
      { id: 'scene-01', name: 'Connecting MCP to Cursor', description: 'Connect Cursor', type: 'desktop' as const },
      { id: 'scene-02', name: 'Orienting to the Data', description: 'Show the schema', type: 'desktop' as const },
      { id: 'scene-03', name: 'Wrap-up', description: 'Summary', type: 'desktop' as const },
    ];

    await s.sendMessage('Plan it', captureLlm, scene, {}, siblings);

    expect(captured).toContain('3-scene demo');
    expect(captured).toContain('Connecting MCP to Cursor');
    expect(captured).toContain('Wrap-up');
    // CURRENT SCENE marker should appear on the active scene only
    expect(captured).toMatch(/Orienting to the Data \[desktop\] — Show the schema ◀ CURRENT SCENE/);
    expect(captured).not.toMatch(/Connecting MCP to Cursor.*CURRENT SCENE/);
  });

  it('omits the storyboard block when no sibling scenes are provided', async () => {
    let captured = '';
    const captureLlm: LlmClient = {
      async complete(opts) {
        captured = opts.userPrompt;
        return { text: MOCK_LLM_TEXT };
      },
    };
    const s = new ShotPlanSession('p1', 'scene-01');
    const scene = { id: 'scene-01', name: 'Solo', description: 'd', type: 'desktop' as const };

    await s.sendMessage('Plan it', captureLlm, scene, {});

    expect(captured).not.toContain('Storyboard context');
    expect(captured).not.toContain('CURRENT SCENE');
  });
});
