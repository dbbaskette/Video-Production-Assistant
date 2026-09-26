import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brandPaths } from './paths.js';
import { readRegistry } from './registry.js';
import { readBrand } from './store.js';
import { syncTanzuBrand, TANZU_BRAND_SLUG } from './tanzu-brand-source.js';

let tempRoot: string;
let packageRoot: string;
let paths: ReturnType<typeof brandPaths>;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'vpa-tanzu-brand-'));
  packageRoot = join(tempRoot, 'package');
  paths = brandPaths(join(tempRoot, 'workspace'), join(tempRoot, '.vpa'));
  await writePackage('2026.5.3');
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('Tanzu Brand source adapter', () => {
  it('imports the verified package, sets it as default, and remains idempotent', async () => {
    const first = await syncTanzuBrand(paths, paths.registryFile, packageRoot);
    expect(first).toMatchObject({ status: 'created', brandVersion: '2026.02', packageVersion: '2026.5.3', vpaVersion: 1 });

    const brand = await readBrand(paths, paths.registryFile, TANZU_BRAND_SLUG);
    expect(brand.doc.frontMatter).toMatchObject({
      version: '2026.02',
      name: 'Tanzu Division',
      rounded: { sm: '0px', md: '0px', lg: '0px' },
      tanzuBrand: { provider: 'tanzu-brand', brandVersion: '2026.02', packageVersion: '2026.5.3' },
    });
    expect(brand.doc.frontMatter.vpa?.audio.bumper_intro).toBe('assets/bumpers/intro.mp4');
    expect((await readRegistry(paths.registryFile)).default_brand_id).toBe(TANZU_BRAND_SLUG);
    expect(await readFile(join(paths.brandDir(TANZU_BRAND_SLUG), 'assets', 'logo.png'), 'utf8')).toBe('logo');

    const second = await syncTanzuBrand(paths, paths.registryFile, packageRoot);
    expect(second).toMatchObject({ status: 'current', vpaVersion: 1 });
  });

  it('creates a new immutable adapter version when the source package changes', async () => {
    await syncTanzuBrand(paths, paths.registryFile, packageRoot);
    await writePackage('2026.5.4');
    const result = await syncTanzuBrand(paths, paths.registryFile, packageRoot);
    expect(result).toMatchObject({ status: 'updated', packageVersion: '2026.5.4', vpaVersion: 2 });
  });

  it('recognizes the installed skill layout without a repository package.json', async () => {
    await unlink(join(packageRoot, 'package.json'));
    await writeFile(join(packageRoot, 'brand', 'install-manifest.json'), JSON.stringify({
      brandVersion: '2026.02',
      sourceCommit: '4b96a55d1aa1fa6fb343002de5f09f006c1e354a',
      contentDigest: '6c4291a31acf44d05cf2fe7fbda9a419c5a32e8be746585a63ebdcbe0602174e',
    }));
    const result = await syncTanzuBrand(paths, paths.registryFile, packageRoot);
    expect(result).toMatchObject({ status: 'created', packageVersion: '2026.02+4b96a55d1aa1' });
  });

  it('fails rather than importing an asset that does not match the manifest', async () => {
    await writeFile(join(packageRoot, 'assets', 'logo.png'), 'tampered');
    await expect(syncTanzuBrand(paths, paths.registryFile, packageRoot)).rejects.toThrow(/checksum mismatch/);
  });

  it('leaves the registry untouched when no package is installed', async () => {
    expect(await syncTanzuBrand(paths, paths.registryFile, null)).toEqual({ status: 'unavailable' });
    expect(await readRegistry(paths.registryFile)).toEqual({ default_brand_id: null, brands: [] });
  });
});

async function writePackage(version: string): Promise<void> {
  const files = {
    'assets/logo.png': 'logo',
    'assets/bumpers/intro.mp4': 'intro',
    'assets/bumpers/outro.mp4': 'outro',
  } as const;
  for (const [relative, value] of Object.entries(files)) {
    const path = join(packageRoot, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, value);
  }
  const asset = (path: keyof typeof files) => ({
    path,
    sha256: createHash('sha256').update(files[path]).digest('hex'),
  });
  await mkdir(join(packageRoot, 'brand'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'tanzu-brand', version }));
  await writeFile(join(packageRoot, 'brand', 'tokens.json'), JSON.stringify({
    brandId: 'tanzu-division',
    brandVersion: '2026.02',
    typography: { primary: { family: 'Arial' } },
    colors: { raw: {
      black: '#000000', white: '#FFFFFF', darkBlue: '#1B1D36', blue: '#005C8A', aqua: '#007B8C',
      purple: '#6C4B94', azure: '#0098C7', green: '#61A60E', red: '#CC092F', orange: '#E68C28',
      broadcomGray: '#E2E3E4', greenTextAA: '#23800A',
    } },
    geometry: { rectangularRadiusPx: 0 },
  }));
  await writeFile(join(packageRoot, 'brand', 'asset-manifest.json'), JSON.stringify({
    assets: {
      logoBug: asset('assets/logo.png'),
      bumperIntro: asset('assets/bumpers/intro.mp4'),
      bumperOutro: asset('assets/bumpers/outro.mp4'),
    },
  }));
}
