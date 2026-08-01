import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REHEARSAL_EVIDENCE_JSON_SCHEMA,
  createCodexSceneRunner,
} from './codex-runner.js';
import type { JsonlProcessRequest } from '../process/jsonl-process.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vpa-codex-runner-'));
  roots.push(root);
  return root;
}

const rehearsal = {
  success: true,
  targetApplication: 'Safari',
  windowTitle: 'Demo',
  windowBounds: { x: 10, y: 20, width: 1280, height: 720 },
  completedStepIndexes: [0, 1],
  checkpoints: [{ description: 'Ready', passed: true }],
  resetConfirmed: true,
  diagnostic: 'Rehearsal completed and reset.',
};

const message = (value: unknown) => ({
  type: 'item.completed',
  item: { type: 'agent_message', text: typeof value === 'string' ? value : JSON.stringify(value) },
});

describe('CodexSceneRunner', () => {
  it('writes the fixed schema, starts a persistent thread, and validates rehearsal evidence', async () => {
    const sessionScratchDir = await scratch();
    const runProcess = vi.fn(async (request: JsonlProcessRequest) => {
      request.onEvent?.({ type: 'thread.started', thread_id: 'thread-123' });
      return {
        // The bounded process history may no longer retain thread.started.
        events: [message({ ignored: true }), message(rehearsal)],
        stderr: '',
        exitCode: 0,
      };
    });
    const runner = createCodexSceneRunner('/workspace', { runProcess, timeoutMs: 9000 });
    const env = { VPA_DRIVER_SESSION_ID: 'session-1' };
    const controller = new AbortController();

    await expect(runner.rehearse('Rehearse the approved plan.', sessionScratchDir, env, controller.signal))
      .resolves.toEqual({ threadId: 'thread-123', evidence: rehearsal });

    const schemaPath = path.join(sessionScratchDir, 'rehearsal-output.schema.json');
    expect(JSON.parse(await readFile(schemaPath, 'utf8'))).toEqual(REHEARSAL_EVIDENCE_JSON_SCHEMA);
    expect(runProcess).toHaveBeenCalledWith({
      executable: 'codex',
      args: [
        'exec', '--json', '--sandbox', 'workspace-write', '--output-schema', schemaPath,
        '-C', '/workspace', '-',
      ],
      cwd: '/workspace',
      stdin: expect.stringContaining('Rehearse the approved plan.'),
      env,
      timeoutMs: 9000,
      signal: controller.signal,
      onEvent: expect.any(Function),
    });
    const prompt = runProcess.mock.calls[0]![0].stdin;
    expect(prompt).toContain('Do not edit, create, delete, or move repository files.');
    expect(prompt).toContain('Do not run Cap commands');
    expect(prompt).toContain('other than the approved target application');
    expect(prompt).toContain('Do not access, reveal, or store secrets.');
    expect(prompt).toContain('Do not upload or publish anything.');
    expect(prompt).toContain('Do not perform destructive actions.');
  });

  it('rejects missing thread IDs and malformed rehearsal JSON', async () => {
    const sessionScratchDir = await scratch();
    const missingThread = createCodexSceneRunner('/workspace', {
      runProcess: vi.fn(async () => ({ events: [message(rehearsal)], stderr: '', exitCode: 0 })),
    });
    await expect(missingThread.rehearse('prompt', sessionScratchDir, {}))
      .rejects.toThrow('did not return a thread ID');

    const malformed = createCodexSceneRunner('/workspace', {
      runProcess: vi.fn(async () => ({
        events: [{ type: 'thread.started', thread_id: 'thread-1' }, message('{bad json')],
        stderr: '',
        exitCode: 0,
      })),
    });
    await expect(malformed.rehearse('prompt', sessionScratchDir, {}))
      .rejects.toThrow('malformed rehearsal evidence JSON');
  });

  it('resumes the exact thread and validates separate execution evidence', async () => {
    const evidence = {
      success: true,
      completedStepIndexes: [0, 1],
      checkpoints: [{ description: 'Saved', passed: true, detail: 'Visible' }],
      diagnostic: 'Recording actions completed.',
    };
    const runProcess = vi.fn(async (_request: JsonlProcessRequest) => ({
      events: [message('old'), message(evidence)],
      stderr: '',
      exitCode: 0,
    }));
    const runner = createCodexSceneRunner('/workspace', { runProcess });
    const env = { VPA_DRIVER_TOKEN: 'opaque' };
    const controller = new AbortController();

    await expect(runner.resumeForRecording('thread-123', 'Execute the rehearsed plan.', env, controller.signal))
      .resolves.toEqual(evidence);
    expect(runProcess).toHaveBeenCalledWith({
      executable: 'codex',
      args: ['exec', 'resume', 'thread-123', '--json', '-'],
      cwd: '/workspace',
      stdin: expect.stringContaining('Execute the rehearsed plan.'),
      env,
      timeoutMs: 600_000,
      signal: controller.signal,
    });
    expect(runProcess.mock.calls[0]![0].stdin).toContain('"completedStepIndexes"');
  });

  it('rejects malformed recording evidence and CLI errors', async () => {
    const malformed = createCodexSceneRunner('/workspace', {
      runProcess: vi.fn(async () => ({ events: [message({ success: true })], stderr: '', exitCode: 0 })),
    });
    await expect(malformed.resumeForRecording('thread-1', 'prompt', {}))
      .rejects.toThrow('invalid recording execution evidence');

    const failed = createCodexSceneRunner('/workspace', {
      runProcess: vi.fn(async () => ({
        events: [{ type: 'error', message: 'desktop helper failed' }],
        stderr: '',
        exitCode: 0,
      })),
    });
    await expect(failed.resumeForRecording('thread-1', 'prompt', {}))
      .rejects.toThrow('Codex CLI failed: desktop helper failed');
  });
});
