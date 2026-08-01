import { describe, expect, it, vi } from 'vitest';
import type { JsonlProcessRequest, JsonlProcessResult } from '../process/jsonl-process.js';
import { createMacOSDesktopPlatform } from './macos.js';
import type { ResolvedDesktopDriverTarget } from './types.js';

const target: ResolvedDesktopDriverTarget = {
  bundleId: 'com.example.MeetingNotes',
  displayName: 'MeetingNotes',
  processId: 42,
  windowId: 77,
  windowTitle: 'Settings',
  bounds: { x: 1, y: 2, width: 1200, height: 800 },
};

function result(events: object[] = []): JsonlProcessResult {
  return { events: events as Array<Record<string, unknown>>, stderr: '', exitCode: 0 };
}

describe('macOS desktop platform process boundary', () => {
  it('passes dynamic target data only through stdin to the shared bounded process runner', async () => {
    const dynamicTitle = 'Settings `$(unsafe)`';
    const resolved = { ...target, windowTitle: dynamicTitle };
    const runProcess = vi.fn(async (_request: JsonlProcessRequest) => result([resolved]));
    const platform = createMacOSDesktopPlatform({ runProcess });

    await expect(platform.resolveTarget({ ...resolved, processId: undefined })).resolves.toEqual(resolved);
    const request = runProcess.mock.calls[0]![0];
    expect(request.executable).toBe('/usr/bin/osascript');
    expect(request.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(request.args[3]).not.toContain(dynamicTitle);
    expect(JSON.parse(request.stdin)).toMatchObject({ windowTitle: dynamicTitle });
    expect(request.timeoutMs).toBe(15_000);
  });

  it('propagates abort signals through verification, actions, and window capture', async () => {
    const controller = new AbortController();
    const runProcess = vi.fn(async (request: JsonlProcessRequest) => {
      if (request.executable === '/usr/sbin/screencapture') return result();
      if (request.stdin.includes('"action"')) return result([{ ok: true }]);
      return result([target]);
    });
    const checkAccess = vi.fn(async () => undefined);
    const platform = createMacOSDesktopPlatform({ runProcess, access: checkAccess as never });

    await platform.screenshot(target, '/tmp/session/window.png', controller.signal);
    await platform.act(target, { kind: 'type-text', value: 'fixture' }, {
      reference: { path: [1, 2] }, role: 'AXTextField', title: 'Notes', enabled: true,
      actions: ['AXSetValue'], focused: true,
    }, controller.signal);

    expect(runProcess).toHaveBeenCalledTimes(3);
    for (const [request] of runProcess.mock.calls) expect(request.signal).toBe(controller.signal);
    expect(runProcess.mock.calls[1]![0]).toMatchObject({
      executable: '/usr/sbin/screencapture',
      args: ['-x', '-l', '77', '/tmp/session/window.png'],
      stdin: '',
    });
    const actionRequest = runProcess.mock.calls[2]![0];
    expect(actionRequest.args[3]).not.toContain('process.frontmost = true');
    expect(JSON.parse(actionRequest.stdin)).toMatchObject({
      target: { windowId: 77, processId: 42 },
      action: { kind: 'type-text', value: 'fixture' },
      reference: { path: [1, 2] },
    });
    expect(checkAccess).toHaveBeenCalledWith('/tmp/session/window.png');
  });

  it('fails closed when native JSON output is missing or duplicated', async () => {
    const empty = createMacOSDesktopPlatform({ runProcess: vi.fn(async () => result()) });
    await expect(empty.resolveTarget(target)).rejects.toThrow('returned an invalid result');

    const duplicate = createMacOSDesktopPlatform({
      runProcess: vi.fn(async () => result([target, target])),
    });
    await expect(duplicate.resolveTarget(target)).rejects.toThrow('returned an invalid result');
  });
});
