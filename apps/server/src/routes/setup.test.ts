import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerSetupRoutes } from './setup.js';

const ready = {
  state: 'ready' as const,
  installed: true,
  cliPath: '/verified/cap',
  version: '1.0.0',
  captureReady: true,
  missingPermissions: [],
  targetCount: 2,
  updatedAt: new Date().toISOString(),
};

function deps() {
  return {
    tts: {} as never,
    llm: {} as never,
    vpaHome: '/tmp/vpa',
    capRuntime: {
      getStatus: vi.fn(async () => ready),
    },
    capInstaller: {
      start: vi.fn(async () => ({ installationId: '64d79770-ee07-4f70-b084-2115dc28e0d3', state: 'installing' as const })),
    },
  };
}

describe('Cap setup routes', () => {
  it('returns typed status and forces discovery only for the check route', async () => {
    const app = Fastify();
    const injected = deps();
    await registerSetupRoutes(app, injected);

    const status = await app.inject({ method: 'GET', url: '/api/setup/cap' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual(ready);
    expect(injected.capRuntime.getStatus).toHaveBeenNthCalledWith(1, false);

    const check = await app.inject({ method: 'POST', url: '/api/setup/cap/check' });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual(ready);
    expect(injected.capRuntime.getStatus).toHaveBeenNthCalledWith(2, true);
  });

  it('requires confirmed true and returns 202 for an accepted install', async () => {
    const app = Fastify();
    const injected = deps();
    await registerSetupRoutes(app, injected);

    const invalid = await app.inject({ method: 'POST', url: '/api/setup/cap/install', payload: { confirmed: false } });
    expect(invalid.statusCode).toBe(400);
    expect(injected.capInstaller.start).not.toHaveBeenCalled();

    const accepted = await app.inject({ method: 'POST', url: '/api/setup/cap/install', payload: { confirmed: true } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ installationId: '64d79770-ee07-4f70-b084-2115dc28e0d3', state: 'installing' });
  });

  it('returns conflict for a duplicate install and 500 for an installer launch failure', async () => {
    const app = Fastify();
    const injected = deps();
    const duplicate = Object.assign(new Error('already installing'), { code: 'INSTALL_IN_PROGRESS' });
    injected.capInstaller.start.mockRejectedValueOnce(duplicate);
    injected.capInstaller.start.mockRejectedValueOnce(new Error('cannot create installer job'));
    await registerSetupRoutes(app, injected);

    const conflict = await app.inject({ method: 'POST', url: '/api/setup/cap/install', payload: { confirmed: true } });
    expect(conflict.statusCode).toBe(409);
    const failure = await app.inject({ method: 'POST', url: '/api/setup/cap/install', payload: { confirmed: true } });
    expect(failure.statusCode).toBe(500);
  });
});
