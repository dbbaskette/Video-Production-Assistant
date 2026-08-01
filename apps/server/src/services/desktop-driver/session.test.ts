import { describe, expect, it, vi } from 'vitest';
import type {
  DesktopDriverPlatform,
  DesktopDriverPlatformElement,
  DesktopDriverSessionCreateInput,
  ResolvedDesktopDriverTarget,
} from './types.js';
import {
  DesktopDriverError,
  DesktopDriverSessionManager,
} from './session.js';

const target: ResolvedDesktopDriverTarget = {
  bundleId: 'com.example.MeetingNotes',
  displayName: 'MeetingNotes',
  processId: 4242,
  windowId: 77,
  windowTitle: 'Settings',
  bounds: { x: 10, y: 20, width: 1200, height: 800 },
};

function element(overrides: Partial<DesktopDriverPlatformElement> = {}): DesktopDriverPlatformElement {
  return {
    reference: { path: [0] },
    role: 'AXButton',
    title: 'General',
    value: 'visible value',
    enabled: true,
    actions: ['AXPress'],
    ...overrides,
  };
}

function fixture() {
  let clock = new Date('2026-07-31T12:00:00.000Z');
  let currentElements = [element()];
  let currentTarget = structuredClone(target);
  const platform: DesktopDriverPlatform = {
    resolveTarget: vi.fn(async () => structuredClone(currentTarget)),
    inspect: vi.fn(async () => ({ target: structuredClone(currentTarget), elements: structuredClone(currentElements) })),
    screenshot: vi.fn(async () => undefined),
    act: vi.fn(async () => undefined),
  };
  const remove = vi.fn(async () => undefined);
  let nextId = 0;
  const manager = new DesktopDriverSessionManager({
    platform,
    now: () => clock,
    randomToken: () => Buffer.alloc(32, 7),
    randomId: () => nextId++ === 0 ? '11111111-1111-4111-8111-111111111111' : 'shot-id',
    makeTempDirectory: vi.fn(async () => '/tmp/vpa-driver-session-safe'),
    remove,
  });
  const input: DesktopDriverSessionCreateInput = {
    projectId: 'project-1',
    sceneId: 'scene-01',
    planFingerprint: 'fingerprint-1',
    target,
    operations: ['inspect', 'screenshot', 'click', 'set-value', 'type-text', 'press-key'],
    phase: 'rehearsal',
    ttlMs: 60_000,
  };
  return {
    manager, platform, remove, input,
    advanceTime(ms: number) { clock = new Date(clock.getTime() + ms); },
    setElements(value: DesktopDriverPlatformElement[]) { currentElements = value; },
    setTarget(value: ResolvedDesktopDriverTarget) { currentTarget = value; },
  };
}

async function capability(value = fixture()) {
  return { value, capability: await value.manager.create(value.input) };
}

describe('DesktopDriverSessionManager', () => {
  it('creates a 256-bit opaque capability bound to the uniquely resolved target', async () => {
    const value = fixture();
    const created = await value.manager.create(value.input);

    expect(created.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(Buffer.from(created.token, 'base64url')).toHaveLength(32);
    expect(created.token).not.toContain('MeetingNotes');
    expect(created.target).toEqual(target);
    expect(value.platform.resolveTarget).toHaveBeenCalledWith(target);

    const stored = [...((value.manager as unknown as { sessions: Map<string, object> }).sessions).values()][0] as Record<string, unknown>;
    expect(stored).not.toHaveProperty('token');
    expect(stored.tokenHash).toBeInstanceOf(Buffer);
    expect(stored).toMatchObject({
      projectId: 'project-1', sceneId: 'scene-01', planFingerprint: 'fingerprint-1', phase: 'rehearsal',
    });
  });

  it.each([
    ['com.apple.Terminal', 'Terminal'],
    ['com.googlecode.iterm2', 'iTerm2'],
    ['dev.warp.Warp-Stable', 'Warp'],
    ['com.openai.chat', 'ChatGPT'],
    ['com.openai.codex', 'Codex'],
    ['so.cap.desktop', 'Cap'],
    ['com.apple.systemsettings', 'System Settings'],
    ['com.apple.keychainaccess', 'Keychain Access'],
    ['com.1password.1password', '1Password'],
    ['com.example.password-vault', 'Notes'],
    ['com.example.vpa', 'Video Production Assistant'],
  ])('rejects excluded target %s / %s before asking macOS to resolve it', async (bundleId, displayName) => {
    const value = fixture();
    value.input.target = { ...target, bundleId, displayName };
    await expect(value.manager.create(value.input)).rejects.toMatchObject({ code: 'FORBIDDEN_TARGET' });
    expect(value.platform.resolveTarget).not.toHaveBeenCalled();
  });

  it('rejects a resolver that substitutes any other app or window', async () => {
    const value = fixture();
    value.setTarget({ ...target, windowId: 78 });
    await expect(value.manager.create(value.input)).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });

  it('requires the timing-safe token boundary for correct and incorrect session IDs', async () => {
    const { value, capability: created } = await capability();
    await expect(value.manager.inspect(created.sessionId, 'wrong-token')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(value.manager.inspect('22222222-2222-4222-8222-222222222222', created.token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(value.platform.inspect).not.toHaveBeenCalled();
    await expect(value.manager.inspect(created.sessionId, created.token)).resolves.toMatchObject({ generation: 1 });
  });

  it('rejects expired capabilities and operations outside the bound set', async () => {
    const value = fixture();
    value.input.operations = ['inspect'];
    value.input.ttlMs = undefined;
    value.input.expiresAt = new Date('2026-07-31T12:00:00.001Z');
    const created = await value.manager.create(value.input);
    await expect(value.manager.screenshot(created.sessionId, created.token)).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });

    value.advanceTime(2);
    await expect(value.manager.inspect(created.sessionId, created.token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const expired = fixture();
    expired.input.expiresAt = new Date('2026-07-31T11:59:59.000Z');
    await expect(expired.manager.create(expired.input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('bounds accessibility output and redacts secure fields even if the platform returns a value', async () => {
    const { value, capability: created } = await capability();
    value.setElements(Array.from({ length: 510 }, (_, index) => element({
      reference: { path: [index] },
      role: index === 0 ? 'AXSecureTextField' : 'AXButton',
      title: index === 0 ? 'Password' : `button-${index}`,
      value: index === 0 ? 'super-secret' : 'x'.repeat(1_000),
      secure: index === 0,
      actions: Array.from({ length: 30 }, (__, actionIndex) => `action-${actionIndex}`),
    })));

    const snapshot = await value.manager.inspect(created.sessionId, created.token);
    expect(snapshot.elements).toHaveLength(500);
    expect(snapshot.elements[0]).toMatchObject({ index: 0, value: '[REDACTED]' });
    expect(JSON.stringify(snapshot)).not.toContain('super-secret');
    expect(snapshot.elements[1]?.value).toHaveLength(500);
    expect(snapshot.elements[1]?.actions).toHaveLength(20);
  });

  it('issues new sequential indexes each generation and rejects stale or replayed indexes', async () => {
    const { value, capability: created } = await capability();
    value.setElements([
      element({ reference: { path: [0] }, title: 'First' }),
      element({ reference: { path: [1] }, title: 'Second' }),
    ]);
    const first = await value.manager.inspect(created.sessionId, created.token);
    const second = await value.manager.inspect(created.sessionId, created.token);
    expect(first.elements.map(({ index }) => index)).toEqual([0, 1]);
    expect(second.elements.map(({ index }) => index)).toEqual([500, 501]);
    await expect(value.manager.act(created.sessionId, created.token, { kind: 'click', elementIndex: 0 }))
      .rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    await expect(value.manager.act(created.sessionId, created.token, { kind: 'click', elementIndex: 500 }))
      .resolves.toEqual({ ok: true, snapshotInvalidated: true });
    await expect(value.manager.act(created.sessionId, created.token, { kind: 'click', elementIndex: 500 }))
      .rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
  });

  it('refuses to act when the target or visible accessibility state changed', async () => {
    const first = await capability();
    const snapshot = await first.value.manager.inspect(first.capability.sessionId, first.capability.token);
    first.value.setElements([element({ title: 'Changed' })]);
    await expect(first.value.manager.act(first.capability.sessionId, first.capability.token, {
      kind: 'click', elementIndex: snapshot.elements[0]!.index,
    })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(first.value.platform.act).not.toHaveBeenCalled();

    const second = await capability();
    await second.value.manager.inspect(second.capability.sessionId, second.capability.token);
    second.value.setTarget({ ...target, displayName: 'Other App' });
    await expect(second.value.manager.act(second.capability.sessionId, second.capability.token, {
      kind: 'click', elementIndex: 0,
    })).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });

  it('enforces text, key, element, and secure-field restrictions', async () => {
    const { value, capability: created } = await capability();
    await expect(value.manager.act(created.sessionId, created.token, { kind: 'type-text', value: 'x'.repeat(2_001) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(value.manager.act(created.sessionId, created.token, { kind: 'press-key', key: 'Delete' } as never))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(value.manager.act(created.sessionId, created.token, { kind: 'click', elementIndex: -1 }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    value.setElements([element({ role: 'AXSecureTextField', secure: true, actions: ['AXSetValue'] })]);
    await value.manager.inspect(created.sessionId, created.token);
    await expect(value.manager.act(created.sessionId, created.token, { kind: 'set-value', elementIndex: 0, value: 'nope' }))
      .rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
    expect(value.platform.act).not.toHaveBeenCalled();
  });

  it('allows fixture text only on editable controls and rejects sensitive or destructive controls', async () => {
    const first = await capability();
    first.value.setElements([element({
      role: 'AXTextField', title: 'Meeting title', actions: ['AXSetValue'],
    })]);
    await first.value.manager.inspect(first.capability.sessionId, first.capability.token);
    await expect(first.value.manager.act(first.capability.sessionId, first.capability.token, {
      kind: 'set-value', elementIndex: 0, value: 'fixture text',
    })).resolves.toEqual({ ok: true, snapshotInvalidated: true });

    const second = await capability();
    second.value.setElements([element({ title: 'Delete account' })]);
    await second.value.manager.inspect(second.capability.sessionId, second.capability.token);
    await expect(second.value.manager.act(second.capability.sessionId, second.capability.token, {
      kind: 'click', elementIndex: 0,
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
    expect(second.value.platform.act).not.toHaveBeenCalled();
  });

  it('uses only a generated session path for screenshots and deletes it on revoke', async () => {
    const { value, capability: created } = await capability();
    const result = await value.manager.screenshot(created.sessionId, created.token);
    expect(result.path).toBe('/tmp/vpa-driver-session-safe/window-shot-id.png');
    expect(value.platform.screenshot).toHaveBeenCalledWith(target, result.path);

    await value.manager.revoke(created.sessionId);
    expect(value.remove).toHaveBeenCalledWith('/tmp/vpa-driver-session-safe');
    await expect(value.manager.inspect(created.sessionId, created.token)).rejects.toBeInstanceOf(DesktopDriverError);
    await expect(value.manager.revoke(created.sessionId)).resolves.toBeUndefined();
  });
});
