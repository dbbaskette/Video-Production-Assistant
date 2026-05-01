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
  version: 'alpha',
  name: 'Tanzu',
  colors: { primary: '#007B8C', neutral: '#FFFFFF', 'on-surface': '#1A1C1E' },
  typography: {
    'headline-lg': { fontFamily: 'Arial', fontSize: '36px', fontWeight: 700, lineHeight: 1.2 },
    'body-md': { fontFamily: 'Arial', fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
  },
  rounded: { sm: '0px', md: '0px', lg: '0px' },
  spacing: { xs: '4px', sm: '8px', md: '16px' },
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
    expect(list.brands[0]?.version).toBe(1);
  });

  it('readBrand parses design.md and returns BrandWithDoc', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Overview',
    });
    const brand = await readBrand(paths, registryFile, 'tanzu');
    expect(brand.registry.id).toBe('tanzu');
    expect(brand.doc.frontMatter.name).toBe('Tanzu');
    expect(brand.doc.frontMatter.version).toBe('alpha');
    expect(brand.doc.body).toContain('## Overview');
  });

  it('readBrand throws when brand does not exist', async () => {
    await expect(readBrand(paths, registryFile, 'missing')).rejects.toThrow(/not found/);
  });

  it('updateBrandDoc auto-increments registry version', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Old',
    });
    await updateBrandDoc(paths, registryFile, 'tanzu', {
      frontMatter: SAMPLE_FRONTMATTER,
      body: '## New',
    });
    const updated = await readBrand(paths, registryFile, 'tanzu');
    expect(updated.registry.version).toBe(2);
    expect(updated.doc.body).toContain('## New');
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
