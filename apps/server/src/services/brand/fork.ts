import { BrandWithDoc, DesignMdFrontMatter } from '@vpa/shared';
import type { BrandPaths } from './paths.js';
import { createBrand, readBrand } from './store.js';
import { readRegistry } from './registry.js';

export interface ForkBrandInput {
  name: string;
}

export async function forkBrand(
  paths: BrandPaths,
  registryFile: string,
  parentSlug: string,
  input: ForkBrandInput,
): Promise<BrandWithDoc> {
  const parent = await readBrand(paths, registryFile, parentSlug);

  const baseSlug = derivedSlug(parentSlug, input.name);
  const reg = await readRegistry(registryFile);
  const existingSlugs = new Set(reg.brands.map((b) => b.id));
  const slug = uniqueSlug(baseSlug, existingSlugs);

  const forkedFrontMatter: DesignMdFrontMatter = {
    ...parent.doc.frontMatter,
    name: input.name,
    version: 1,
  };

  return createBrand(paths, registryFile, {
    slug,
    name: input.name,
    frontMatter: forkedFrontMatter,
    body: parent.doc.body,
    forkedFrom: parentSlug,
  });
}

function derivedSlug(parentSlug: string, name: string): string {
  const tail = name.split(/[·•|\-—]/).pop()?.trim() ?? name;
  const slugified = slugify(tail);
  return slugified ? `${parentSlug}--${slugified}` : `${parentSlug}--copy`;
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('Could not generate unique slug after 1000 attempts');
}
