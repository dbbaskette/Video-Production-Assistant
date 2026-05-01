import { describe, it, expect } from 'vitest';
import type { LlmClient } from '../llm/index.js';
import { parseScenesFromResponse, IdeationSession, IdeationManager } from './index.js';

const MOCK_LLM_TEXT =
  'Here are the scenes:\n\n```json\n{"scenes": [{"id": "scene-01", "name": "Test Scene", "description": "A test", "type": "desktop"}]}\n```\n\nLet me know if you want changes!';

const mockLlm: LlmClient = {
  async complete() {
    return { text: MOCK_LLM_TEXT };
  },
};

describe('parseScenesFromResponse', () => {
  it('extracts scenes from a response with a JSON code fence', () => {
    const text =
      'Here is my plan:\n\n```json\n{"scenes": [{"id": "s1", "name": "Intro", "description": "Opening shot", "type": "browser"}]}\n```\n\nThoughts?';
    const scenes = parseScenesFromResponse(text);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toEqual({
      id: 's1',
      name: 'Intro',
      description: 'Opening shot',
      type: 'browser',
    });
  });

  it('returns empty array when no JSON fence is present', () => {
    const text = 'Just some text with no code block at all.';
    expect(parseScenesFromResponse(text)).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    const text = '```json\n{not valid json!!!\n```';
    expect(parseScenesFromResponse(text)).toEqual([]);
  });

  it('defaults type to desktop for unknown scene types', () => {
    const text = '```json\n{"scenes": [{"id": "x", "name": "X", "description": "d", "type": "unknown"}]}\n```';
    const scenes = parseScenesFromResponse(text);
    expect(scenes[0]!.type).toBe('desktop');
  });

  it('generates an id when none is provided', () => {
    const text = '```json\n{"scenes": [{"name": "No ID", "description": "test"}]}\n```';
    const scenes = parseScenesFromResponse(text);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.id).toMatch(/^scene-/);
  });
});

describe('IdeationSession', () => {
  it('sendMessage adds user and assistant messages with scenes', async () => {
    const session = new IdeationSession('proj-1');
    const reply = await session.sendMessage('Create a demo about Docker', mockLlm);

    // Should have both user and assistant messages
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]!.role).toBe('user');
    expect(session.messages[0]!.content).toBe('Create a demo about Docker');
    expect(session.messages[1]!.role).toBe('assistant');

    // Reply should be the assistant message
    expect(reply.role).toBe('assistant');
    expect(reply.scenes).toHaveLength(1);
    expect(reply.scenes![0]!.name).toBe('Test Scene');

    // proposedScenes should be updated
    expect(session.proposedScenes).toHaveLength(1);
    expect(session.proposedScenes[0]!.id).toBe('scene-01');
  });

  it('sendMessage strips the JSON block from assistant content', async () => {
    const session = new IdeationSession('proj-2');
    const reply = await session.sendMessage('Plan a demo', mockLlm);

    // The assistant content should not contain the JSON fence
    expect(reply.content).not.toContain('```json');
    expect(reply.content).toContain('Here are the scenes:');
    expect(reply.content).toContain('Let me know if you want changes!');
  });

  it('sendMessage passes objective to the LLM prompt', async () => {
    let capturedPrompt = '';
    const captureLlm: LlmClient = {
      async complete(opts) {
        capturedPrompt = opts.userPrompt;
        return { text: MOCK_LLM_TEXT };
      },
    };

    const session = new IdeationSession('proj-3');
    await session.sendMessage('Plan it', captureLlm, 'Show Kubernetes basics');

    expect(capturedPrompt).toContain('Project objective: Show Kubernetes basics');
  });

  it('getState returns current messages and proposed scenes', async () => {
    const session = new IdeationSession('proj-4');
    await session.sendMessage('Hello', mockLlm);

    const state = session.getState();
    expect(state.projectId).toBe('proj-4');
    expect(state.messages).toHaveLength(2);
    expect(state.proposedScenes).toHaveLength(1);
  });
});

describe('IdeationManager', () => {
  it('getOrCreate creates a new session and returns same on second call', () => {
    const mgr = new IdeationManager();
    const s1 = mgr.getOrCreate('proj-a');
    const s2 = mgr.getOrCreate('proj-a');

    expect(s1).toBe(s2);
    expect(s1.projectId).toBe('proj-a');
  });

  it('get returns undefined for unknown project', () => {
    const mgr = new IdeationManager();
    expect(mgr.get('nonexistent')).toBeUndefined();
  });

  it('delete removes the session', () => {
    const mgr = new IdeationManager();
    mgr.getOrCreate('proj-b');
    expect(mgr.get('proj-b')).toBeDefined();

    mgr.delete('proj-b');
    expect(mgr.get('proj-b')).toBeUndefined();
  });
});
