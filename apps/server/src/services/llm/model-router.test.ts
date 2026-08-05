import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project } from '@vpa/shared';
import type { LlmClient } from './index.js';
import { ModelRegistry, type ModelEntry, type ModelsFile } from './model-registry.js';
import { RetryingLlm } from './retrying.js';
import { ModelRouter, ModelRoutingError } from './model-router.js';

const tempDirs: string[] = [];

async function createRegistry(
  models: ModelEntry[],
  assignments: ModelsFile['assignments'],
): Promise<ModelRegistry> {
  const directory = await mkdtemp(path.join(tmpdir(), 'vpa-model-router-'));
  tempDirs.push(directory);
  const filePath = path.join(directory, 'models.json');
  await writeFile(filePath, JSON.stringify({ version: 2, models, assignments }));
  const registry = new ModelRegistry(filePath);
  await registry.load({});
  return registry;
}

function project(modelRouting: Project['model_routing']): Project {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'demo',
    path: '/private/project-path',
    created: '2026-08-01T00:00:00.000Z',
    brand: null,
    model_routing: modelRouting,
  };
}

function client(text = 'ok'): LlmClient {
  return { complete: vi.fn(async () => ({ text })) };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ModelRouter', () => {
  it('uses a project override before the global assignment and returns to global when the override is cleared', async () => {
    const globalEntry: ModelEntry = {
      id: 'global-writer', name: 'Global writer', provider: 'fake', model: 'global-model',
    };
    const projectEntry: ModelEntry = {
      id: 'project-writer', name: 'Project writer', provider: 'anthropic', model: 'project-model', apiKey: 'secret',
    };
    const registry = await createRegistry([globalEntry, projectEntry], { writing: globalEntry.id });
    const createClient = vi.fn((_entry: ModelEntry) => client());
    const router = new ModelRouter({
      registry,
      createClient,
      checkCliReady: vi.fn(async () => ({ ready: true })),
    });

    const overridden = await router.resolveText('writing', project({ writing: projectEntry.id }));
    const inherited = await router.resolveText('writing', project({}));

    expect(overridden.summary).toMatchObject({
      role: 'writing', scope: 'project', entry_id: projectEntry.id, provider: 'anthropic', model: 'project-model',
    });
    expect(inherited.summary).toMatchObject({
      role: 'writing', scope: 'global', entry_id: globalEntry.id, provider: 'fake', model: 'global-model',
    });
    expect(createClient.mock.calls.map(([entry]) => entry.id)).toEqual([projectEntry.id, globalEntry.id]);
  });

  it('reports an unassigned global role with a stable public error', async () => {
    const registry = await createRegistry([], {});
    const router = new ModelRouter({
      registry,
      createClient: vi.fn(() => client()),
      checkCliReady: vi.fn(async () => ({ ready: true })),
    });

    await expect(router.resolveText('general')).rejects.toMatchObject({
      code: 'model_assignment_missing',
      role: 'general',
      scope: 'global',
      statusCode: 422,
    });
  });

  it('reports an assignment whose model entry no longer exists', async () => {
    const registry = await createRegistry([], { writing: 'deleted-model' });
    const router = new ModelRouter({
      registry,
      createClient: vi.fn(() => client()),
      checkCliReady: vi.fn(async () => ({ ready: true })),
    });

    await expect(router.resolveText('writing')).rejects.toMatchObject({
      code: 'model_assignment_invalid',
      role: 'writing',
      scope: 'global',
      statusCode: 422,
    });
  });

  it('requires Gemini for a project video assignment without constructing a text client', async () => {
    const writer: ModelEntry = {
      id: 'writer', name: 'Writer', provider: 'anthropic', model: 'claude', apiKey: 'secret',
    };
    const registry = await createRegistry([writer], {});
    const createClient = vi.fn(() => client());
    const router = new ModelRouter({
      registry,
      createClient,
      checkCliReady: vi.fn(async () => ({ ready: true })),
    });

    await expect(router.resolveVideo(project({ video_understanding: writer.id }))).rejects.toMatchObject({
      code: 'model_capability_mismatch',
      role: 'video-understanding',
      scope: 'project',
      statusCode: 422,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('reports a Gemini video assignment without an API key as unavailable', async () => {
    const gemini: ModelEntry = {
      id: 'gemini', name: 'Gemini', provider: 'gemini', model: 'gemini-2.5-pro',
    };
    const registry = await createRegistry([gemini], { 'video-understanding': gemini.id });
    const createClient = vi.fn(() => client());
    const router = new ModelRouter({
      registry,
      createClient,
      checkCliReady: vi.fn(async () => ({ ready: true })),
    });

    await expect(router.resolveVideo()).rejects.toMatchObject({
      code: 'model_unavailable',
      role: 'video-understanding',
      scope: 'global',
      statusCode: 503,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns Gemini video credentials and never constructs a text client', async () => {
    const gemini: ModelEntry = {
      id: 'gemini', name: 'Gemini Pro', provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'gemini-secret',
    };
    const registry = await createRegistry([gemini], { 'video-understanding': gemini.id });
    const createClient = vi.fn(() => client());
    const router = new ModelRouter({
      registry,
      createClient,
      checkCliReady: vi.fn(async () => ({ ready: true })),
    });

    await expect(router.resolveVideo()).resolves.toMatchObject({
      apiKey: 'gemini-secret',
      model: 'gemini-2.5-pro',
      summary: { role: 'video-understanding', provider: 'gemini', ready: true },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns Gemini visual credentials through the persisted video-understanding role', async () => {
    const gemini: ModelEntry = {
      id: 'gemini', name: 'Gemini Pro', provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'gemini-secret',
    };
    const registry = await createRegistry([gemini], { 'video-understanding': gemini.id });
    const createClient = vi.fn(() => client());
    const router = new ModelRouter({
      registry,
      createClient,
      checkCliReady: vi.fn(async () => ({ ready: true })),
    });

    await expect(router.resolveVisual()).resolves.toMatchObject({
      apiKey: 'gemini-secret',
      model: 'gemini-2.5-pro',
      summary: { role: 'video-understanding', provider: 'gemini', ready: true },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'codex-cli'] as const)(
    'awaits the injected readiness probe and blocks an unavailable %s assignment',
    async (provider) => {
      const cli: ModelEntry = { id: provider, name: provider, provider, model: 'default' };
      const registry = await createRegistry([cli], { general: cli.id });
      const checkCliReady = vi.fn(async () => ({ ready: false, message: 'private CLI diagnostic' }));
      const createClient = vi.fn(() => client());
      const router = new ModelRouter({ registry, createClient, checkCliReady });

      const rejection = router.resolveText('general');

      await expect(rejection).rejects.toMatchObject({
        code: 'model_unavailable', role: 'general', scope: 'global', statusCode: 503,
      });
      await expect(rejection).rejects.not.toThrow('private CLI diagnostic');
      expect(checkCliReady).toHaveBeenCalledWith(provider);
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it('wraps the one selected text client in the shared retry boundary', async () => {
    const writer: ModelEntry = { id: 'writer', name: 'Writer', provider: 'fake', model: 'fake' };
    const registry = await createRegistry([writer], { writing: writer.id });
    const inner = client('written');
    const router = new ModelRouter({
      registry,
      createClient: vi.fn(() => inner),
      checkCliReady: vi.fn(async () => ({ ready: true })),
    });

    const resolved = await router.resolveText('writing');

    expect(resolved.client).toBeInstanceOf(RetryingLlm);
    await expect(resolved.client.complete({ systemPrompt: 'system', userPrompt: 'user' }))
      .resolves.toEqual({ text: 'written' });
  });

  it('does not try another catalog entry when the selected client factory fails', async () => {
    const selected: ModelEntry = { id: 'selected', name: 'Selected', provider: 'fake', model: 'selected-model' };
    const spare: ModelEntry = { id: 'spare', name: 'Spare', provider: 'fake', model: 'spare-model' };
    const registry = await createRegistry([selected, spare], { writing: selected.id });
    const createClient = vi.fn(() => {
      throw new Error('provider failed with credential super-secret');
    });
    const warn = vi.fn();
    const router = new ModelRouter({
      registry,
      createClient,
      checkCliReady: vi.fn(async () => ({ ready: true })),
      warn,
    });

    const rejection = router.resolveText('writing');

    await expect(rejection).rejects.toBeInstanceOf(ModelRoutingError);
    await expect(rejection).rejects.toMatchObject({ code: 'model_unavailable', statusCode: 503 });
    await expect(rejection).rejects.not.toThrow('super-secret');
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(selected);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('describes routing failures with a bounded, credential-free not-ready summary', async () => {
    const writer: ModelEntry = { id: 'writer', name: 'Writer', provider: 'fake', model: 'fake' };
    const registry = await createRegistry([writer], { writing: writer.id });
    const router = new ModelRouter({
      registry,
      createClient: vi.fn(() => { throw new Error('authorization super-secret failed'); }),
      checkCliReady: vi.fn(async () => ({ ready: true })),
      warn: vi.fn(),
    });

    const summary = await router.describe('writing');

    expect(summary).toMatchObject({
      role: 'writing', scope: 'global', ready: false, code: 'model_unavailable',
    });
    expect(summary).not.toHaveProperty('entry_id');
    expect(summary).not.toHaveProperty('apiKey');
    if (!('message' in summary)) throw new Error('Expected a not-ready routing summary');
    expect(summary.message).not.toContain('super-secret');
    expect(summary.message.length).toBeLessThanOrEqual(500);
  });
});
