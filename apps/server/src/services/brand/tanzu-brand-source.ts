import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { DesignMdFrontMatter } from '@vpa/shared';
import type { BrandPaths } from './paths.js';
import { readRegistry, setDefault } from './registry.js';
import { createBrand, readBrand, updateBrandDoc } from './store.js';

export const TANZU_BRAND_SLUG = 'vmware-tanzu';

interface TanzuTokens {
  brandId: string;
  brandVersion: string;
  typography: { primary: { family: string } };
  colors: { raw: Record<string, string> };
  geometry: { rectangularRadiusPx: number };
}

interface ManifestAsset {
  path: string;
  sha256: string;
}

interface TanzuManifest {
  assets: {
    logoBug: ManifestAsset;
    bumperIntro: ManifestAsset;
    bumperOutro: ManifestAsset;
  };
}

interface PackageJson {
  name: string;
  version: string;
}

interface InstallManifest {
  brandVersion: string;
  sourceCommit: string;
  contentDigest: string;
}

export interface TanzuBrandSyncResult {
  status: 'unavailable' | 'created' | 'updated' | 'current';
  root?: string;
  brandVersion?: string;
  packageVersion?: string;
  vpaVersion?: number;
}

export async function findTanzuBrandRoot(explicitRoot = process.env.TANZU_BRAND_PATH): Promise<string | null> {
  const candidates = [
    explicitRoot,
    join(homedir(), '.agents', 'skills', 'tanzu-brand'),
  ].filter((candidate): candidate is string => !!candidate?.trim());

  for (const candidate of candidates) {
    const root = resolve(candidate);
    try {
      await Promise.all([
        access(join(root, 'brand', 'tokens.json')),
        access(join(root, 'brand', 'asset-manifest.json')),
      ]);
      await Promise.any([
        access(join(root, 'package.json')),
        access(join(root, 'brand', 'install-manifest.json')),
      ]);
      return root;
    } catch {
      // Try the next supported installation location.
    }
  }
  return null;
}

export async function syncTanzuBrand(
  paths: BrandPaths,
  registryFile: string,
  rootOverride?: string | null,
): Promise<TanzuBrandSyncResult> {
  const root = rootOverride === null ? null : await findTanzuBrandRoot(rootOverride);
  if (!root) return { status: 'unavailable' };

  const [tokens, manifest, sourceVersion] = await Promise.all([
    readJson<TanzuTokens>(join(root, 'brand', 'tokens.json')),
    readJson<TanzuManifest>(join(root, 'brand', 'asset-manifest.json')),
    readSourceVersion(root),
  ]);
  if (!sourceVersion || tokens.brandId !== 'tanzu-division' || !tokens.brandVersion) {
    throw new Error(`Invalid Tanzu Brand package at ${root}`);
  }

  const assets = [manifest.assets.logoBug, manifest.assets.bumperIntro, manifest.assets.bumperOutro];
  for (const asset of assets) await copyVerifiedAsset(root, paths.brandDir(TANZU_BRAND_SLUG), asset);

  const frontMatter = DesignMdFrontMatter.parse({
    version: tokens.brandVersion,
    name: 'Tanzu Division',
    description: `Managed by the canonical Tanzu Brand ${tokens.brandVersion} package.`,
    colors: {
      primary: requiredColor(tokens, 'blue'),
      secondary: requiredColor(tokens, 'darkBlue'),
      aqua: requiredColor(tokens, 'aqua'),
      purple: requiredColor(tokens, 'purple'),
      azure: requiredColor(tokens, 'azure'),
      green: requiredColor(tokens, 'green'),
      neutral: requiredColor(tokens, 'white'),
      surface: requiredColor(tokens, 'broadcomGray'),
      'on-surface': requiredColor(tokens, 'black'),
      success: requiredColor(tokens, 'greenTextAA'),
      warning: requiredColor(tokens, 'orange'),
      danger: requiredColor(tokens, 'red'),
    },
    typography: {
      'headline-lg': { fontFamily: tokens.typography.primary.family, fontSize: '36px', fontWeight: 700, lineHeight: 1.2 },
      'headline-md': { fontFamily: tokens.typography.primary.family, fontSize: '28px', fontWeight: 700, lineHeight: 1.3 },
      'body-lg': { fontFamily: tokens.typography.primary.family, fontSize: '18px', fontWeight: 400, lineHeight: 1.5 },
      'body-md': { fontFamily: tokens.typography.primary.family, fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
      'label-md': { fontFamily: tokens.typography.primary.family, fontSize: '14px', fontWeight: 700, lineHeight: 1.4 },
    },
    rounded: {
      sm: `${tokens.geometry.rectangularRadiusPx}px`,
      md: `${tokens.geometry.rectangularRadiusPx}px`,
      lg: `${tokens.geometry.rectangularRadiusPx}px`,
    },
    spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px', xxl: '48px' },
    components: {
      'button-primary': { backgroundColor: '{colors.primary}', textColor: '{colors.neutral}', rounded: '{rounded.sm}' },
      card: { backgroundColor: '{colors.neutral}', textColor: '{colors.on-surface}', rounded: '{rounded.md}' },
      link: { textColor: '{colors.primary}', typography: 'body-md' },
    },
    vpa: {
      voice: { tone: 'Clear, confident, direct, and technically precise.', avoid: ['unexplained jargon', 'hype', 'ambiguous claims'] },
      audio: {
        music_mood: null,
        sonic_logo: null,
        bumper_intro: manifest.assets.bumperIntro.path,
        bumper_outro: manifest.assets.bumperOutro.path,
        default_music_track: null,
      },
      logo: { primary: manifest.assets.logoBug.path, mono: null, safe_zone_ratio: 0.25 },
      lower_thirds: { template: 'bar-left-accent', bg: '{colors.secondary}', fg: '{colors.neutral}' },
      production: {
        captions: { preset: 'clean', font_family: tokens.typography.primary.family, foreground: '#FFFFFF', background: '#1B1D36' },
        callouts: { preset: 'label', foreground: '#FFFFFF', background: '#005C8A' },
        narration: { profile_id: null, speed: 1 },
      },
      taglines: [],
    },
    tanzuBrand: {
      provider: 'tanzu-brand',
      brandVersion: tokens.brandVersion,
      packageVersion: sourceVersion,
    },
  });
  const body = managedBody(tokens.brandVersion, sourceVersion);

  let current;
  try {
    current = await readBrand(paths, registryFile, TANZU_BRAND_SLUG);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('not found')) throw error;
  }

  let status: TanzuBrandSyncResult['status'];
  let vpaVersion: number;
  if (!current) {
    const created = await createBrand(paths, registryFile, {
      slug: TANZU_BRAND_SLUG,
      name: frontMatter.name,
      frontMatter,
      body,
    });
    status = 'created';
    vpaVersion = created.registry.version;
  } else {
    if (!/tanzu/i.test(current.doc.frontMatter.name)) {
      throw new Error(`Reserved brand ID "${TANZU_BRAND_SLUG}" is already used by an unrelated brand`);
    }
    const source = (current.doc.frontMatter as Record<string, unknown>).tanzuBrand as Record<string, unknown> | undefined;
    if (source?.packageVersion === sourceVersion && source?.brandVersion === tokens.brandVersion) {
      status = 'current';
      vpaVersion = current.registry.version;
    } else {
      const updated = await updateBrandDoc(paths, registryFile, TANZU_BRAND_SLUG, { frontMatter, body });
      status = 'updated';
      vpaVersion = updated.registry.version;
    }
  }

  const registry = await readRegistry(registryFile);
  if (!registry.default_brand_id) await setDefault(registryFile, TANZU_BRAND_SLUG);
  return { status, root, brandVersion: tokens.brandVersion, packageVersion: sourceVersion, vpaVersion };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readSourceVersion(root: string): Promise<string> {
  try {
    const packageJson = await readJson<PackageJson>(join(root, 'package.json'));
    if (packageJson.name !== 'tanzu-brand' || !packageJson.version) throw new Error('Invalid package.json');
    return packageJson.version;
  } catch (error) {
    try {
      const installed = await readJson<InstallManifest>(join(root, 'brand', 'install-manifest.json'));
      if (!installed.brandVersion || !installed.sourceCommit || !installed.contentDigest) throw new Error('Invalid install manifest');
      return `${installed.brandVersion}+${installed.sourceCommit.slice(0, 12)}`;
    } catch {
      throw error;
    }
  }
}

function requiredColor(tokens: TanzuTokens, name: string): string {
  const value = tokens.colors?.raw?.[name];
  if (!value) throw new Error(`Tanzu Brand tokens are missing colors.raw.${name}`);
  return value;
}

async function copyVerifiedAsset(root: string, destinationRoot: string, asset: ManifestAsset): Promise<void> {
  if (!asset?.path || !asset.sha256 || isAbsolute(asset.path) || normalize(asset.path).startsWith('..')) {
    throw new Error('Tanzu Brand manifest contains an unsafe asset path');
  }
  const source = join(root, asset.path);
  const bytes = await readFile(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) throw new Error(`Tanzu Brand asset checksum mismatch: ${asset.path}`);
  const destination = join(destinationRoot, asset.path);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await writeFile(destination, bytes);
}

function managedBody(brandVersion: string, packageVersion: string): string {
  return `# Tanzu Brand\n\nThis adapter is managed by the canonical \`tanzu-brand\` package. Do not edit it in VPA.\n\n- Brand version: ${brandVersion}\n- Package version: ${packageVersion}\n- Identity assets are copied only after their manifest checksums pass.\n- Update the installed package to change this adapter.\n`;
}
