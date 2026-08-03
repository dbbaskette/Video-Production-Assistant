import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRegistry } from './model-registry.js';

const tempDirs: string[] = [];

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
      .rejects.toThrow('Model "missing" not found');
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

    await expect(registry.load({ GEMINI_API_KEY: 'env-secret' })).rejects.toThrow('disk unavailable');

    expect(registry.getAssignments()).toEqual({ writing: 'writer', general: 'writer' });
    expect(JSON.parse(await readFile(filePath, 'utf8')).assignments).toEqual({
      writing: 'writer',
      general: 'writer',
    });
  });
});
