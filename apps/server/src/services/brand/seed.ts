/**
 * Seed brands — copies built-in brand(s) from the repo into ~/.vpa/brands/
 * on first launch. Skips any brand whose slug already exists in the registry.
 */
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { DesignMdFrontMatter } from '@vpa/shared';
import type { BrandPaths } from './paths.js';
import { readRegistry, addEntry, setDefault } from './registry.js';

/** Directory inside the repo that contains seed brand folders */
function seedDir(): string {
  // import.meta.dirname is apps/server/src/services/brand/
  // seed-brands/ lives at apps/server/seed-brands/
  return resolve(import.meta.dirname, '../../../seed-brands');
}

export async function seedBrands(
  paths: BrandPaths,
  registryFile: string,
): Promise<void> {
  const root = seedDir();

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // No seed-brands directory — nothing to seed
    return;
  }

  const registry = await readRegistry(registryFile);
  const existingSlugs = new Set(registry.brands.map((b) => b.id));

  let seededAny = false;

  for (const slug of entries) {
    // Skip hidden files, non-directories
    if (slug.startsWith('.')) continue;
    const seedPath = join(root, slug);
    const info = await stat(seedPath);
    if (!info.isDirectory()) continue;

    // Skip if already in registry
    if (existingSlugs.has(slug)) continue;

    // Read the seed design.md to get name & validate
    const designPath = join(seedPath, 'design.md');
    let raw: string;
    try {
      raw = await readFile(designPath, 'utf8');
    } catch {
      // No design.md — skip this folder
      continue;
    }

    const parsed = matter(raw, {
      engines: {
        yaml: { parse: (s: string) => yaml.load(s) as object, stringify: (o: object) => yaml.dump(o) },
      },
    });

    let fm: DesignMdFrontMatter;
    try {
      fm = DesignMdFrontMatter.parse(parsed.data);
    } catch {
      // Invalid frontmatter — skip
      continue;
    }

    // Copy the entire brand directory into ~/.vpa/brands/{slug}
    const destDir = paths.brandDir(slug);
    await mkdir(destDir, { recursive: true });
    await cp(seedPath, destDir, { recursive: true });

    // Ensure source-docs dir exists (brand pipeline expects it)
    await mkdir(paths.sourceDocsDir(slug), { recursive: true });

    // Add to registry
    const now = new Date().toISOString();
    await addEntry(registryFile, {
      id: slug,
      name: fm.name,
      version: 1,
      created: now,
      updated: now,
      forked_from: null,
    });

    seededAny = true;
  }

  // If we seeded brands and there's no default yet, set the first seeded one
  if (seededAny) {
    const updated = await readRegistry(registryFile);
    if (!updated.default_brand_id && updated.brands.length > 0) {
      await setDefault(registryFile, updated.brands[0]!.id);
    }
  }
}
