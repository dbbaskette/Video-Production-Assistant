import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_JSONL_FRAME_BYTES, runJsonlProcess } from './jsonl-process.js';

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child as unknown as FakeChild;
}

function request(overrides: Partial<Parameters<typeof runJsonlProcess>[0]> = {}) {
  return {
    executable: 'codex',
    args: ['exec', '--json', '-'],
    cwd: '/workspace',
    stdin: 'prompt',
    env: { TEST_TOKEN: 'safe' },
    timeoutMs: 1_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runJsonlProcess', () => {
  it('spawns without a shell, writes stdin, and parses fragmented JSONL exactly once', async () => {
    const child = fakeChild();
    let stdin = '';
    child.stdin.on('data', (chunk) => { stdin += chunk.toString(); });
    const onEvent = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.write('{"type":"thread.started","thread_');
        child.stdout.write('id":"thread-1"}\n\n{"type":"item.completed",');
        child.stdout.write('"item":{"type":"agent_message","text":"done"}}');
        child.stdout.end('\n');
        child.stderr.end('warning');
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;

    const result = await runJsonlProcess(request({ onEvent }), { spawn: spawnProcess });

    expect(spawnProcess).toHaveBeenCalledWith('codex', ['exec', '--json', '-'], {
      cwd: '/workspace',
      env: { TEST_TOKEN: 'safe' },
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(stdin).toBe('prompt');
    expect(result).toEqual({
      events: [
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      ],
      stderr: 'warning',
      exitCode: 0,
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('retains only the latest 500 events and bounds stderr to 16 KiB', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(`${Array.from({ length: 502 }, (_, index) => JSON.stringify({ index })).join('\n')}\n`);
        child.stderr.end('x'.repeat(20 * 1024));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;

    const result = await runJsonlProcess(request(), { spawn: spawnProcess });

    expect(result.events).toHaveLength(500);
    expect(result.events[0]).toEqual({ index: 2 });
    expect(Buffer.byteLength(result.stderr)).toBe(16 * 1024);
  });

  it('rejects nonzero exits with bounded stderr diagnostics', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.end('authentication required');
        child.emit('close', 7);
      });
      return child;
    }) as unknown as typeof spawn;

    await expect(runJsonlProcess(request(), { spawn: spawnProcess }))
      .rejects.toThrow('codex exited with code 7: authentication required');
  });

  it('rejects malformed terminal output', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('{"type":');
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;

    await expect(runJsonlProcess(request(), { spawn: spawnProcess }))
      .rejects.toThrow('Malformed JSONL output from codex');
  });

  it('terminates and rejects on timeout', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const signalProcessTree = vi.fn();

    const pending = runJsonlProcess(request({ timeoutMs: 25 }), {
      spawn: spawnProcess,
      signalProcessTree,
    });
    const rejection = expect(pending).rejects.toThrow('codex timed out after 25ms');
    await vi.advanceTimersByTimeAsync(25);

    expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
    // A timeout is not reported until child close confirms termination.
    child.emit('close', null);
    await rejection;
  });

  it('terminates and rejects on abort', async () => {
    const controller = new AbortController();
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const signalProcessTree = vi.fn();
    const pending = runJsonlProcess(request({ signal: controller.signal }), {
      spawn: spawnProcess,
      signalProcessTree,
    });
    const rejection = expect(pending).rejects.toThrow('codex process aborted');

    controller.abort();

    expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
    child.emit('close', null);
    await rejection;
  });

  it('observes synchronous close when the signal aborts during spawn', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      controller.abort();
      return child;
    }) as unknown as typeof spawn;
    const signalProcessTree = vi.fn((_child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') child.emit('close', null);
    });

    const pending = runJsonlProcess(request({ signal: controller.signal }), {
      spawn: spawnProcess,
      signalProcessTree,
      terminationGraceMs: 10,
      forceKillWaitMs: 10,
    });

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'codex process aborted',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(signalProcessTree).toHaveBeenCalledTimes(1);
    expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
  });

  it('escalates a process tree to SIGKILL and bounds the final close wait', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const signalProcessTree = vi.fn();
    const pending = runJsonlProcess(request({ timeoutMs: 5 }), {
      spawn: spawnProcess,
      signalProcessTree,
      terminationGraceMs: 10,
      forceKillWaitMs: 20,
    });
    const rejection = expect(pending).rejects.toThrow(
      'codex timed out after 5ms; process did not close after SIGKILL',
    );

    await vi.advanceTimersByTimeAsync(5);
    expect(signalProcessTree).toHaveBeenNthCalledWith(1, child, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(10);
    expect(signalProcessTree).toHaveBeenNthCalledWith(2, child, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
  });

  it('terminates an oversized unterminated JSONL frame', async () => {
    const child = fakeChild();
    const signalProcessTree = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.stdout.write('x'.repeat(MAX_JSONL_FRAME_BYTES + 1)));
      return child;
    }) as unknown as typeof spawn;
    const pending = runJsonlProcess(request(), { spawn: spawnProcess, signalProcessTree });
    const rejection = expect(pending).rejects.toThrow(
      `Malformed JSONL output from codex: JSONL frame exceeded ${MAX_JSONL_FRAME_BYTES} bytes`,
    );

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
    child.emit('close', null);
    await rejection;
  });

  it('normalizes asynchronous spawn failures', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    }) as unknown as typeof spawn;

    await expect(runJsonlProcess(request(), { spawn: spawnProcess }))
      .rejects.toThrow('Failed to spawn codex: ENOENT');
  });

  it('handles stdin EPIPE without rejecting before the child close is known', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    let settled = false;
    const pending = runJsonlProcess(request(), { spawn: spawnProcess });
    void pending.finally(() => { settled = true; }).catch(() => undefined);

    child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);

    child.stderr.end('child closed input');
    child.emit('close', 9);
    await expect(pending).rejects.toThrow('codex exited with code 9: child closed input');
  });
});
