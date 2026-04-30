import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandPaths } from './paths.js';
import { createBrand, readBrand, updateBrandDoc, deleteBrand, listBrands } from './store.js';

let tmp: string;
let paths: ReturnType<typeof brandPaths>;
let registryFile: string;

const SAMPLE_FRONTMATTER = {
  name: 'Tanzu',
  version: 1,
  colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
  typography: {
    heading: { family: 'Inter', weights: [600, 700] },
    body: { family: 'Inter', weights: [400, 500] },
  },
  rounded: { sm: 4, md: 8, lg: 16 },
  spacing: { unit: 8, scale: [4, 8, 16, 24, 32] },
  components: {},
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-store-'));
  await mkdir(join(tmp, '.vpa'), { recursive: true });
  paths = brandPaths(tmp, join(tmp, '.vpa'));
  registryFile = paths.registryFile;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('brand store', () => {
  it('createBrand creates directory tree and writes design.md + registry entry', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu',
      frontMatter: SAMPLE_FRONTMATTER,
      body: '## Overview\n\nTanzu is...',
    });

    const written = await readFile(paths.designMd('tanzu'), 'utf8');
    expect(written).toMatch(/^---\n/);
    expect(written).toMatch(/name: Tanzu/);
    expect(written).toMatch(/## Overview/);

    const list = await listBrands(registryFile);
    expect(list.brands).toHaveLength(1);
    expect(list.brands[0]?.id).toBe('tanzu');
  });

  it('readBrand parses design.md and returns BrandWithDoc', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Overview',
    });
    const brand = await readBrand(paths, registryFile, 'tanzu');
    expect(brand.registry.id).toBe('tanzu');
    expect(brand.doc.frontMatter.name).toBe('Tanzu');
    expect(brand.doc.body).toContain('## Overview');
  });

  it('readBrand throws when brand does not exist', async () => {
    await expect(readBrand(paths, registryFile, 'missing')).rejects.toThrow(/not found/);
  });

  it('updateBrandDoc bumps version and writes new content', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Old',
    });
    await updateBrandDoc(paths, registryFile, 'tanzu', {
      frontMatter: { ...SAMPLE_FRONTMATTER, version: 2 },
      body: '## New',
    });
    const updated = await readBrand(paths, registryFile, 'tanzu');
    expect(updated.registry.version).toBe(2);
    expect(updated.doc.body).toContain('## New');
  });

  it('updateBrandDoc rejects version that does not increment', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Old',
    });
    await expect(updateBrandDoc(paths, registryFile, 'tanzu', {
      frontMatter: { ...SAMPLE_FRONTMATTER, version: 1 },
      body: '## Same',
    })).rejects.toThrow(/version must increment/);
  });

  it('deleteBrand removes directory and registry entry', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Overview',
    });
    await deleteBrand(paths, registryFile, 'tanzu');
    expect((await listBrands(registryFile)).brands).toEqual([]);
    await expect(readFile(paths.designMd('tanzu'), 'utf8')).rejects.toThrow();
  });
});
