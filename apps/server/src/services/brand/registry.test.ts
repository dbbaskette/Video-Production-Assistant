import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry, writeRegistry, addEntry, updateEntry, removeEntry, setDefault } from './registry.js';

let tmp: string;
let registryFile: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-brand-'));
  registryFile = join(tmp, 'brands.json');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('registry', () => {
  it('returns an empty registry when file does not exist', async () => {
    const r = await readRegistry(registryFile);
    expect(r).toEqual({ default_brand_id: null, brands: [] });
  });

  it('round-trips through write + read', async () => {
    await writeRegistry(registryFile, { default_brand_id: null, brands: [] });
    const r = await readRegistry(registryFile);
    expect(r.brands).toEqual([]);
  });

  it('addEntry appends and updates', async () => {
    await addEntry(registryFile, {
      id: 'tanzu', name: 'Tanzu', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    const r = await readRegistry(registryFile);
    expect(r.brands).toHaveLength(1);
    expect(r.brands[0]?.id).toBe('tanzu');
  });

  it('addEntry rejects duplicate slug', async () => {
    const entry = {
      id: 'tanzu', name: 'Tanzu', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    };
    await addEntry(registryFile, entry);
    await expect(addEntry(registryFile, entry)).rejects.toThrow(/already exists/);
  });

  it('updateEntry bumps version and updated timestamp', async () => {
    await addEntry(registryFile, {
      id: 'tanzu', name: 'Tanzu', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    await updateEntry(registryFile, 'tanzu', { version: 2 });
    const r = await readRegistry(registryFile);
    expect(r.brands[0]?.version).toBe(2);
    expect(r.brands[0]?.updated).not.toBe('2026-04-30T00:00:00Z');
  });

  it('setDefault enforces single-default invariant', async () => {
    await addEntry(registryFile, {
      id: 'a', name: 'A', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    await addEntry(registryFile, {
      id: 'b', name: 'B', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    await setDefault(registryFile, 'a');
    expect((await readRegistry(registryFile)).default_brand_id).toBe('a');
    await setDefault(registryFile, 'b');
    expect((await readRegistry(registryFile)).default_brand_id).toBe('b');
    await setDefault(registryFile, null);
    expect((await readRegistry(registryFile)).default_brand_id).toBeNull();
  });

  it('removeEntry clears default if the removed brand was default', async () => {
    await addEntry(registryFile, {
      id: 'a', name: 'A', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    await setDefault(registryFile, 'a');
    await removeEntry(registryFile, 'a');
    const r = await readRegistry(registryFile);
    expect(r.brands).toEqual([]);
    expect(r.default_brand_id).toBeNull();
  });

  it('readRegistry rejects malformed file', async () => {
    await writeFile(registryFile, '{ broken json', 'utf8');
    await expect(readRegistry(registryFile)).rejects.toThrow();
  });
});
