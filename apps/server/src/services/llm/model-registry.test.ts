import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRegistry } from './model-registry.js';

const tempDirs: string[] = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createRegistryFile(contents: unknown): Promise<{ registry: ModelRegistry; filePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'vpa-model-registry-'));
  tempDirs.push(directory);
  const filePath = path.join(directory, 'models.json');
  await writeFile(filePath, JSON.stringify(contents));
  return { registry: new ModelRegistry(filePath), filePath };
}

async function createRawRegistryFile(contents: string): Promise<{ registry: ModelRegistry; filePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'vpa-model-registry-'));
  tempDirs.push(directory);
  const filePath = path.join(directory, 'models.json');
  await writeFile(filePath, contents);
  return { registry: new ModelRegistry(filePath), filePath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ModelRegistry', () => {
  it('migrates an unversioned catalog to role assignments without persisting secrets or active flags in summaries', async () => {
    const { registry, filePath } = await createRegistryFile({
      models: [
        { id: 'writer', name: 'Writer', provider: 'claude-code', model: 'sonnet', active: true },
        { id: 'vision', name: 'Vision', provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'secret', active: false },
      ],
    });

    await registry.load({});

    expect(registry.getAssignments()).toEqual({
      writing: 'writer',
      general: 'writer',
      'video-understanding': 'vision',
    });
    expect(registry.getAssignment('writing')).toBe('writer');
    expect(registry.getById('vision')?.apiKey).toBe('secret');
    expect(registry.list()).toContainEqual({
      id: 'vision',
      name: 'Vision',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      hasApiKey: true,
      capabilities: { text: true, video: true },
      ready: true,
    });

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted).toEqual({
      version: 2,
      models: expect.arrayContaining([
        { id: 'writer', name: 'Writer', provider: 'claude-code', model: 'sonnet' },
        { id: 'vision', name: 'Vision', provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'secret' },
      ]),
      assignments: {
        writing: 'writer',
        general: 'writer',
        'video-understanding': 'vision',
      },
    });
    expect(JSON.stringify(persisted)).not.toContain('active');
    expect(JSON.stringify(registry.list())).not.toContain('secret');
  });

  it('leaves video understanding unassigned when legacy Gemini entries are not configured', async () => {
    const { registry } = await createRegistryFile({
      version: 1,
      models: [
        { id: 'writer', name: 'Writer', provider: 'claude-code', model: 'sonnet', active: true },
        { id: 'vision', name: 'Vision', provider: 'gemini', model: 'gemini-2.5-pro', active: false },
      ],
    });

    await registry.load({});

    expect(registry.getAssignments()).toEqual({ writing: 'writer', general: 'writer' });
    expect(registry.getAssignment('video-understanding')).toBeUndefined();
    expect(registry.list()).toContainEqual(expect.objectContaining({
      id: 'vision',
      hasApiKey: false,
      capabilities: { text: true, video: true },
      ready: false,
      readinessMessage: 'API key is missing',
    }));
  });

  it('allows roles to share an entry and clears only explicitly null assignments', async () => {
    const { registry } = await createRegistryFile({
      version: 2,
      models: [{ id: 'writer', name: 'Writer', provider: 'claude-code', model: 'sonnet' }],
      assignments: {},
    });
    await registry.load({});

    await registry.setAssignments({ writing: 'writer', general: 'writer' });
    await registry.setAssignments({ 'video-understanding': 'writer' });
    await registry.setAssignments({ general: null });

    expect(registry.getAssignments()).toEqual({ writing: 'writer', 'video-understanding': 'writer' });

    await expect(registry.setAssignments({ writing: 'missing', general: null }))
      .rejects.toMatchObject({ code: 'invalid_assignment' });
    expect(registry.getAssignments()).toEqual({ writing: 'writer', 'video-understanding': 'writer' });
  });

  it('merges environment entries without replacing persisted assignments', async () => {
    const { registry } = await createRegistryFile({
      version: 2,
      models: [{ id: 'writer', name: 'Writer', provider: 'claude-code', model: 'sonnet' }],
      assignments: { writing: 'writer', general: 'writer' },
    });

    await registry.load({ GEMINI_API_KEY: 'env-secret', GEMINI_MODEL: 'gemini-2.5-pro' });

    expect(registry.getAssignments()).toEqual({ writing: 'writer', general: 'writer' });
    expect(registry.getById('gemini')).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      apiKey: 'env-secret',
    });
  });

  it('surfaces malformed persisted JSON without replacing the catalog from environment', async () => {
    const { registry, filePath } = await createRawRegistryFile('{not valid JSON');

    await expect(registry.load({ VPA_LLM_PROVIDER: 'codex-cli' })).rejects.toThrow();

    expect(await readFile(filePath, 'utf8')).toBe('{not valid JSON');
    expect(registry.getAssignments()).toEqual({});
  });

  it('surfaces a merge save failure without replacing loaded assignments', async () => {
    const { filePath } = await createRegistryFile({
      version: 2,
      models: [{ id: 'writer', name: 'Writer', provider: 'claude-code', model: 'sonnet' }],
      assignments: { writing: 'writer', general: 'writer' },
    });
    const rejectWrite = async (): Promise<void> => {
      throw new Error('disk unavailable');
    };
    const registry = new ModelRegistry(filePath, rejectWrite);

    await expect(registry.load({ GEMINI_API_KEY: 'env-secret' }))
      .rejects.toMatchObject({ code: 'persistence_failed' });

    expect(registry.getAssignments()).toEqual({ writing: 'writer', general: 'writer' });
    expect(JSON.parse(await readFile(filePath, 'utf8')).assignments).toEqual({
      writing: 'writer',
      general: 'writer',
    });
  });

  it.each([
    ['setAssignments', async (registry: ModelRegistry) => registry.setAssignments({ writing: 'writer' })],
    ['add', async (registry: ModelRegistry) => registry.add({
      id: 'added', name: 'Added', provider: 'fake', model: 'added-model',
    })],
    ['update', async (registry: ModelRegistry) => registry.update('writer', { name: 'Changed' })],
    ['remove', async (registry: ModelRegistry) => registry.remove('writer')],
  ] as const)('keeps runtime and disk unchanged when %s persistence rejects', async (_name, mutate) => {
    const { filePath } = await createRegistryFile({
      version: 2,
      models: [{ id: 'writer', name: 'Writer', provider: 'fake', model: 'writer-v1' }],
      assignments: { writing: 'writer', general: 'writer' },
    });
    let rejectWrites = false;
    const persist = vi.fn(async (target: string, contents: string) => {
      if (rejectWrites) throw new Error(`/private/catalog/models.json could not be saved: ${target}`);
      await writeFile(target, contents);
    });
    const registry = new ModelRegistry(filePath, persist);
    await registry.load({});
    const beforeDisk = await readFile(filePath, 'utf8');
    const beforeModels = registry.list();
    const beforeAssignments = registry.getAssignments();
    rejectWrites = true;

    await expect(mutate(registry)).rejects.toThrow();

    expect(registry.list()).toEqual(beforeModels);
    expect(registry.getAssignments()).toEqual(beforeAssignments);
    expect(await readFile(filePath, 'utf8')).toBe(beforeDisk);
    // A failed delete must not silently clear either assignment.
    if (_name === 'remove') {
      expect(registry.getAssignments()).toEqual({ writing: 'writer', general: 'writer' });
      expect(registry.getById('writer')).toBeDefined();
    }
  });

  it('serializes concurrent assignment patches so acknowledged writes compose', async () => {
    const { filePath } = await createRegistryFile({
      version: 2,
      models: [
        { id: 'writer', name: 'Writer', provider: 'fake', model: 'writer-v1' },
        { id: 'general', name: 'General', provider: 'fake', model: 'general-v1' },
      ],
      assignments: {},
    });
    const firstWrite = deferred();
    let block = false;
    const writes: string[] = [];
    const persist = vi.fn(async (_target: string, contents: string) => {
      writes.push(contents);
      if (block && writes.length === 1) await firstWrite.promise;
    });
    const registry = new ModelRegistry(filePath, persist);
    await registry.load({});
    persist.mockClear();
    writes.length = 0;
    block = true;

    const first = registry.setAssignments({ writing: 'writer' });
    const second = registry.setAssignments({ general: 'general' });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(registry.getAssignments()).toEqual({});
    firstWrite.resolve();
    await Promise.all([first, second]);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(JSON.parse(writes[0]!).assignments).toEqual({ writing: 'writer' });
    expect(JSON.parse(writes[1]!).assignments).toEqual({ writing: 'writer', general: 'general' });
    expect(registry.getAssignments()).toEqual({ writing: 'writer', general: 'general' });
  });

  it.each([
    {
      name: 'add',
      setup: async (_registry: ModelRegistry) => {},
      first: (registry: ModelRegistry) => registry.add({ id: 'one', name: 'One', provider: 'fake', model: 'one' }),
      second: (registry: ModelRegistry) => registry.add({ id: 'two', name: 'Two', provider: 'fake', model: 'two' }),
      assertFinal: (registry: ModelRegistry) => expect(registry.list().map((entry) => entry.id)).toEqual(expect.arrayContaining(['one', 'two'])),
    },
    {
      name: 'update',
      setup: async (registry: ModelRegistry) => { await registry.add({ id: 'target', name: 'Target', provider: 'fake', model: 'v1' }); },
      first: (registry: ModelRegistry) => registry.update('target', { name: 'First name' }),
      second: (registry: ModelRegistry) => registry.update('target', { model: 'v2' }),
      assertFinal: (registry: ModelRegistry) => expect(registry.getById('target')).toMatchObject({ name: 'First name', model: 'v2' }),
    },
    {
      name: 'remove',
      setup: async (registry: ModelRegistry) => {
        await registry.add({ id: 'one', name: 'One', provider: 'fake', model: 'one' });
        await registry.add({ id: 'two', name: 'Two', provider: 'fake', model: 'two' });
      },
      first: (registry: ModelRegistry) => registry.remove('one'),
      second: (registry: ModelRegistry) => registry.remove('two'),
      assertFinal: (registry: ModelRegistry) => {
        expect(registry.getById('one')).toBeUndefined();
        expect(registry.getById('two')).toBeUndefined();
      },
    },
  ])('serializes concurrent $name mutations against the last durable candidate', async ({ setup, first, second, assertFinal }) => {
    const { filePath } = await createRegistryFile({ version: 2, models: [], assignments: {} });
    const gate = deferred();
    const writes: string[] = [];
    let block = false;
    const persist = vi.fn(async (_target: string, contents: string) => {
      writes.push(contents);
      if (block && writes.length === 1) await gate.promise;
    });
    const registry = new ModelRegistry(filePath, persist);
    await registry.load({});
    await setup(registry);
    persist.mockClear();
    writes.length = 0;
    block = true;

    const firstMutation = first(registry);
    const secondMutation = second(registry);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    gate.resolve();
    await Promise.all([firstMutation, secondMutation]);

    expect(persist).toHaveBeenCalledTimes(2);
    assertFinal(registry);
    expect(JSON.parse(writes[1]!).models).toEqual(
      registry.list().map(({ hasApiKey: _hasApiKey, capabilities: _capabilities, ready: _ready, readinessMessage: _readinessMessage, ...entry }) => entry),
    );
  });

  it('defensively rejects invalid runtime candidates without calling persistence', async () => {
    const { registry } = await createRegistryFile({ version: 2, models: [], assignments: {} });
    await registry.load({});
    const before = registry.list();

    await expect(registry.add({
      id: 'bad',
      name: 'Bad',
      provider: 'not-a-provider',
      model: 'bad',
    } as never)).rejects.toThrow();
    await expect(registry.update('fake', {
      provider: 'gemini',
    } as never)).rejects.toThrow();

    expect(registry.list()).toEqual(before);
  });
});
