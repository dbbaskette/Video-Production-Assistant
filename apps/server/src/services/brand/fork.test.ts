import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandPaths } from './paths.js';
import { createBrand, readBrand } from './store.js';
import { forkBrand } from './fork.js';

let tmp: string;
let paths: ReturnType<typeof brandPaths>;
let registryFile: string;

const SAMPLE_FRONTMATTER = {
  version: 'alpha',
  name: 'Tanzu',
  colors: { primary: '#0091DA', neutral: '#FFFFFF', 'on-surface': '#1A1C1E' },
  typography: {
    'headline-lg': { fontFamily: 'Inter', fontSize: '36px', fontWeight: 600, lineHeight: 1.2 },
    'body-md': { fontFamily: 'Inter', fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
  },
  rounded: { sm: '4px', md: '8px', lg: '16px' },
  spacing: { xs: '4px', sm: '8px' },
  components: {},
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-fork-'));
  await mkdir(join(tmp, '.vpa'), { recursive: true });
  paths = brandPaths(tmp, join(tmp, '.vpa'));
  registryFile = paths.registryFile;
  await createBrand(paths, registryFile, {
    slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Overview',
  });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('forkBrand', () => {
  it('creates a new brand directory with parent.json and forked_from set', async () => {
    const fork = await forkBrand(paths, registryFile, 'tanzu', { name: 'Tanzu · Q4 Launch' });
    expect(fork.registry.id).toBe('tanzu--q4-launch');
    expect(fork.registry.forked_from).toBe('tanzu');
    expect(fork.registry.version).toBe(1);
    const parent = JSON.parse(await readFile(paths.parentJson('tanzu--q4-launch'), 'utf8'));
    expect(parent.forked_from).toBe('tanzu');
  });

  it('copies design.md from parent', async () => {
    const fork = await forkBrand(paths, registryFile, 'tanzu', { name: 'Tanzu · Copy' });
    const refetched = await readBrand(paths, registryFile, fork.registry.id);
    expect(refetched.doc.frontMatter.colors.primary).toBe('#0091DA');
    expect(refetched.doc.body).toContain('## Overview');
  });

  it('handles slug collisions by appending a numeric suffix', async () => {
    await forkBrand(paths, registryFile, 'tanzu', { name: 'Tanzu · Copy' });
    const second = await forkBrand(paths, registryFile, 'tanzu', { name: 'Tanzu · Copy' });
    expect(second.registry.id).toBe('tanzu--copy-2');
  });

  it('rejects forking a non-existent parent', async () => {
    await expect(forkBrand(paths, registryFile, 'missing', { name: 'X' })).rejects.toThrow(/not found/);
  });
});
