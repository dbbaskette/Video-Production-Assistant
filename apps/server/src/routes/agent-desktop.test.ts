import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { DesktopDriverError } from '../services/desktop-driver/session.js';
import { registerAgentDesktopRoutes } from './agent-desktop.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const token = 'opaque-capability-token';

function deps() {
  return {
    desktop: {
      inspect: vi.fn(async () => ({ generation: 1, elements: [] })),
      screenshot: vi.fn(async () => ({ path: '/tmp/session/window.png' })),
      act: vi.fn(async () => ({ ok: true as const, snapshotInvalidated: true as const })),
    },
  };
}

describe('agent desktop loopback routes', () => {
  it('requires a bearer capability on every endpoint', async () => {
    const app = Fastify();
    const injected = deps();
    await registerAgentDesktopRoutes(app, injected as never);

    for (const request of [
      { method: 'GET' as const, url: `/internal/agent-recording/driver/${sessionId}/inspect` },
      { method: 'POST' as const, url: `/internal/agent-recording/driver/${sessionId}/screenshot` },
      { method: 'POST' as const, url: `/internal/agent-recording/driver/${sessionId}/action`, payload: { kind: 'type-text', value: 'hello' } },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }
    expect(injected.desktop.inspect).not.toHaveBeenCalled();
    expect(injected.desktop.screenshot).not.toHaveBeenCalled();
    expect(injected.desktop.act).not.toHaveBeenCalled();
  });

  it('passes only the fixed session, credential, and restricted action contract', async () => {
    const app = Fastify();
    const injected = deps();
    await registerAgentDesktopRoutes(app, injected as never);
    const headers = { authorization: `Bearer ${token}` };

    const inspect = await app.inject({ method: 'GET', url: `/internal/agent-recording/driver/${sessionId}/inspect`, headers });
    expect(inspect.statusCode).toBe(200);
    expect(injected.desktop.inspect).toHaveBeenCalledWith(sessionId, token);

    const screenshot = await app.inject({ method: 'POST', url: `/internal/agent-recording/driver/${sessionId}/screenshot`, headers });
    expect(screenshot.statusCode).toBe(200);
    expect(injected.desktop.screenshot).toHaveBeenCalledWith(sessionId, token);

    const action = await app.inject({
      method: 'POST', url: `/internal/agent-recording/driver/${sessionId}/action`, headers,
      payload: { kind: 'set-value', elementIndex: 8, value: 'fixture text' },
    });
    expect(action.statusCode).toBe(200);
    expect(injected.desktop.act).toHaveBeenCalledWith(sessionId, token, {
      kind: 'set-value', elementIndex: 8, value: 'fixture text',
    });
  });

  it('rejects arbitrary targets, paths, action properties, keys, and oversized requests', async () => {
    const app = Fastify();
    const injected = deps();
    await registerAgentDesktopRoutes(app, injected as never);
    const headers = { authorization: `Bearer ${token}` };
    for (const payload of [
      { kind: 'click', elementIndex: 1, bundleId: 'com.apple.Terminal' },
      { kind: 'screenshot', path: '/tmp/chosen-by-caller.png' },
      { kind: 'press-key', key: 'Delete' },
      { kind: 'run-script', source: 'do dangerous thing' },
    ]) {
      const response = await app.inject({
        method: 'POST', url: `/internal/agent-recording/driver/${sessionId}/action`, headers, payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const tooLarge = await app.inject({
      method: 'POST', url: `/internal/agent-recording/driver/${sessionId}/action`, headers,
      payload: { kind: 'type-text', value: 'x'.repeat(9_000) },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(injected.desktop.act).not.toHaveBeenCalled();
  });

  it('rejects non-loopback clients and adds no CORS relaxation', async () => {
    const app = Fastify();
    const injected = deps();
    await registerAgentDesktopRoutes(app, injected as never);
    const response = await app.inject({
      method: 'GET', url: `/internal/agent-recording/driver/${sessionId}/inspect`,
      headers: { authorization: `Bearer ${token}`, origin: 'https://attacker.example' },
      remoteAddress: '192.0.2.10',
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(injected.desktop.inspect).not.toHaveBeenCalled();
  });

  it('maps safe capability failures without reflecting the bearer token in diagnostics', async () => {
    const app = Fastify();
    const injected = deps();
    injected.desktop.inspect.mockRejectedValueOnce(new DesktopDriverError(
      'UNAUTHORIZED',
      `invalid ${token}`,
    ));
    injected.desktop.inspect.mockRejectedValueOnce(new Error(`platform copied ${token}`));
    await registerAgentDesktopRoutes(app, injected as never);
    const request = {
      method: 'GET' as const,
      url: `/internal/agent-recording/driver/${sessionId}/inspect`,
      headers: { authorization: `Bearer ${token}` },
    };

    const known = await app.inject(request);
    expect(known.statusCode).toBe(401);
    expect(known.body).not.toContain(token);
    expect(known.json()).toMatchObject({ code: 'UNAUTHORIZED' });

    const unknown = await app.inject(request);
    expect(unknown.statusCode).toBe(500);
    expect(unknown.body).not.toContain(token);
    expect(unknown.json()).toEqual({ error: 'Desktop driver operation failed' });
  });
});
