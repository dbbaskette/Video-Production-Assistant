import { describe, expect, it, vi } from 'vitest';
import { createCodexCliLlm } from './codex-cli.js';
import type { JsonlProcessRequest } from '../../process/jsonl-process.js';

const completed = (text: string) => ({
  type: 'item.completed',
  item: { type: 'agent_message', text },
});

describe('createCodexCliLlm', () => {
  it('uses exact shell-free process input and omits the default model', async () => {
    const runProcess = vi.fn(async (_request: JsonlProcessRequest) => ({
      events: [completed('first'), completed('final answer')],
      stderr: '',
      exitCode: 0,
    }));
    const env = { CODEX_HOME: '/test/codex' };
    const llm = createCodexCliLlm('default', {
      workspaceRoot: '/workspace',
      env,
      timeoutMs: 4321,
      runProcess,
    });

    await expect(llm.complete({ systemPrompt: 'system', userPrompt: 'question' }))
      .resolves.toMatchObject({ text: 'final answer' });
    expect(runProcess).toHaveBeenCalledWith({
      executable: 'codex',
      args: ['exec', '--ephemeral', '--json', '--sandbox', 'read-only', '-C', '/workspace', '-'],
      cwd: '/workspace',
      stdin: 'system\n\nquestion',
      env,
      timeoutMs: 4321,
    });
  });

  it('passes a selected model and appends the shared JSON-only constraint', async () => {
    const runProcess = vi.fn(async (_request: JsonlProcessRequest) => ({
      events: [completed('{"ok":true}')],
      stderr: '',
      exitCode: 0,
    }));
    const llm = createCodexCliLlm('gpt-5.6-codex', {
      workspaceRoot: '/workspace',
      runProcess,
    });

    await llm.complete({ systemPrompt: 'system', userPrompt: 'question', responseFormat: 'json' });

    expect(runProcess.mock.calls[0]![0].args).toEqual([
      'exec', '--ephemeral', '--json', '--sandbox', 'read-only', '-C', '/workspace',
      '--model', 'gpt-5.6-codex', '-',
    ]);
    expect(runProcess.mock.calls[0]![0].stdin).toBe(
      'system\n\nquestion\n\nRespond with valid JSON only. No markdown fencing, no explanation.',
    );
  });

  it('surfaces CLI error events', async () => {
    const llm = createCodexCliLlm(undefined, {
      workspaceRoot: '/workspace',
      runProcess: vi.fn(async () => ({
        events: [{ type: 'turn.failed', error: { message: 'login expired' } }],
        stderr: '',
        exitCode: 0,
      })),
    });

    await expect(llm.complete({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow('Codex CLI failed: login expired');
  });

  it('rejects output with no completed agent message and includes stderr', async () => {
    const llm = createCodexCliLlm(undefined, {
      workspaceRoot: '/workspace',
      runProcess: vi.fn(async () => ({
        events: [{ type: 'turn.completed' }],
        stderr: 'unexpected terminal state',
        exitCode: 0,
      })),
    });

    await expect(llm.complete({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow('Codex CLI returned no completed agent message: unexpected terminal state');
  });
});
