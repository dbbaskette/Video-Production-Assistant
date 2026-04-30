import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BrandRegistry, BrandRegistryEntry } from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';

function emptyRegistry(): BrandRegistry {
  return { default_brand_id: null, brands: [] };
}

export async function readRegistry(path: string): Promise<BrandRegistry> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return emptyRegistry();
    throw err;
  }
  return BrandRegistry.parse(JSON.parse(raw));
}

export async function writeRegistry(path: string, registry: BrandRegistry): Promise<void> {
  BrandRegistry.parse(registry);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(registry, null, 2) + '\n');
}

export async function addEntry(path: string, entry: BrandRegistryEntry): Promise<void> {
  const reg = await readRegistry(path);
  if (reg.brands.some((b) => b.id === entry.id)) {
    throw new Error(`Brand "${entry.id}" already exists`);
  }
  reg.brands.push(BrandRegistryEntry.parse(entry));
  await writeRegistry(path, reg);
}

export async function updateEntry(
  path: string,
  id: string,
  patch: Partial<Omit<BrandRegistryEntry, 'id' | 'created' | 'forked_from'>>,
): Promise<BrandRegistryEntry> {
  const reg = await readRegistry(path);
  const idx = reg.brands.findIndex((b) => b.id === id);
  if (idx < 0) throw new Error(`Brand "${id}" not found`);
  const current = reg.brands[idx]!;
  const next = BrandRegistryEntry.parse({ ...current, ...patch, updated: new Date().toISOString() });
  reg.brands[idx] = next;
  await writeRegistry(path, reg);
  return next;
}

export async function removeEntry(path: string, id: string): Promise<void> {
  const reg = await readRegistry(path);
  reg.brands = reg.brands.filter((b) => b.id !== id);
  if (reg.default_brand_id === id) reg.default_brand_id = null;
  await writeRegistry(path, reg);
}

export async function setDefault(path: string, id: string | null): Promise<void> {
  const reg = await readRegistry(path);
  if (id !== null && !reg.brands.some((b) => b.id === id)) {
    throw new Error(`Cannot set default: brand "${id}" not found`);
  }
  reg.default_brand_id = id;
  await writeRegistry(path, reg);
}
