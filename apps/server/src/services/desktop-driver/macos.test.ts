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
  it('derives bundle identity from the trusted Cap owner and window only through fixed-source stdin', async () => {
    const runProcess = vi.fn(async (_request: JsonlProcessRequest) => result([target]));
    const platform = createMacOSDesktopPlatform({ runProcess });
    await expect(platform.resolveWindowOwnerTarget!({ displayName: 'MeetingNotes', windowId: 77, windowTitle: 'Settings' })).resolves.toEqual(target);
    const request = runProcess.mock.calls[0]![0];
    expect(request.args[3]).not.toContain('MeetingNotes');
    expect(request.args[3]).toContain('Cap window owner is not uniquely available');
    expect(JSON.parse(request.stdin)).toEqual({ displayName: 'MeetingNotes', windowId: 77, windowTitle: 'Settings' });
  });

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
    await platform.act(target, { kind: 'press-key', key: 'Return' }, {
      reference: { path: [1, 2] }, role: 'AXButton', title: 'Next section', enabled: true,
      actions: ['AXPress'], focused: true,
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
    expect(actionRequest.args[3]).toContain('verifyElement(approvedElement, request.expectedElement)');
    expect(actionRequest.args[3]).toContain("approvedElement.actions.byName('AXPress').perform()");
    expect(actionRequest.args[3]).toContain('current.role !== expected.role');
    expect(actionRequest.args[3]).toContain('current.title !== expected.title');
    expect(actionRequest.args[3]).toContain('JSON.stringify(current.actions) !== JSON.stringify(expectedActions)');
    expect(JSON.parse(actionRequest.stdin)).toMatchObject({
      target: { windowId: 77, processId: 42 },
      action: { kind: 'press-key', key: 'Return' },
      expectedElement: {
        reference: { path: [1, 2] }, role: 'AXButton', title: 'Next section',
        enabled: true, actions: ['AXPress'], secure: false,
      },
    });
    expect(checkAccess).toHaveBeenCalledWith('/tmp/session/window.png');
  });

  it('carries same-path role, title, and actions for native last-moment identity checks', async () => {
    const runProcess = vi.fn(async (_request: JsonlProcessRequest) => result([{ ok: true }]));
    const platform = createMacOSDesktopPlatform({ runProcess });
    await platform.act(target, { kind: 'press-key', key: 'space' }, {
      reference: { path: [4, 1] }, role: 'AXButton', title: 'Open model settings',
      enabled: true, actions: ['AXPress'], secure: false, focused: true,
    });
    const request = runProcess.mock.calls[0]![0];
    const payload = JSON.parse(request.stdin);
    expect(payload.expectedElement).toEqual({
      reference: { path: [4, 1] }, role: 'AXButton', title: 'Open model settings',
      enabled: true, actions: ['AXPress'], secure: false,
    });
    // The fixed native source checks these expected fields after resolving the
    // path, closing the gap where the same path now names a different control.
    expect(request.args[3]).toContain('Accessibility element identity changed');
    expect(request.args[3]).toContain('current.enabled !== expected.enabled');
    expect(request.args[3]).toContain('current.secure !== expected.secure');
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
