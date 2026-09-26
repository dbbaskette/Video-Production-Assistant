import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { BrandRegistry, BrandWithDoc, DesignMd, DesignMdFrontMatter } from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import type { BrandPaths } from './paths.js';
import { readRegistry, addEntry, updateEntry, removeEntry } from './registry.js';

export interface CreateBrandInput {
  slug: string;
  name: string;
  frontMatter: DesignMdFrontMatter;
  body: string;
  forkedFrom?: string | null;
}

export async function createBrand(
  paths: BrandPaths,
  registryFile: string,
  input: CreateBrandInput,
): Promise<BrandWithDoc> {
  DesignMdFrontMatter.parse(input.frontMatter);

  await mkdir(paths.brandDir(input.slug), { recursive: true });
  await mkdir(paths.assetsDir(input.slug), { recursive: true });
  await mkdir(paths.sourceDocsDir(input.slug), { recursive: true });

  const now = new Date().toISOString();
  const text = serializeDesignMd(input.frontMatter, input.body);
  await atomicWriteFile(paths.designMd(input.slug), text);
  await mkdir(paths.versionsDir(input.slug), { recursive: true });
  await atomicWriteFile(paths.versionDesignMd(input.slug, 1), text);

  if (input.forkedFrom) {
    await atomicWriteFile(
      paths.parentJson(input.slug),
      JSON.stringify({ forked_from: input.forkedFrom, forked_at: now }, null, 2) + '\n',
    );
  }

  await addEntry(registryFile, {
    id: input.slug,
    name: input.name,
    version: 1,
    created: now,
    updated: now,
    forked_from: input.forkedFrom ?? null,
  });

  return readBrand(paths, registryFile, input.slug);
}

export async function readBrand(
  paths: BrandPaths,
  registryFile: string,
  slug: string,
): Promise<BrandWithDoc> {
  const reg = await readRegistry(registryFile);
  const entry = reg.brands.find((b) => b.id === slug);
  if (!entry) throw new Error(`Brand "${slug}" not found`);

  const raw = await readFile(paths.designMd(slug), 'utf8');
  const parsed = matter(raw, {
    engines: {
      yaml: { parse: (s) => yaml.load(s) as object, stringify: (o) => yaml.dump(o) },
    },
  });
  const doc: DesignMd = {
    frontMatter: DesignMdFrontMatter.parse(parsed.data),
    body: parsed.content.trimStart(),
  };
  return { registry: entry, doc };
}

export interface UpdateBrandDocInput {
  frontMatter: DesignMdFrontMatter;
  body: string;
}

export async function updateBrandDoc(
  paths: BrandPaths,
  registryFile: string,
  slug: string,
  input: UpdateBrandDocInput,
): Promise<BrandWithDoc> {
  const current = await readBrand(paths, registryFile, slug);
  DesignMdFrontMatter.parse(input.frontMatter);
  await mkdir(paths.versionsDir(slug), { recursive: true });
  const currentText = serializeDesignMd(current.doc.frontMatter, current.doc.body);
  await atomicWriteFile(paths.versionDesignMd(slug, current.registry.version), currentText);
  const nextText = serializeDesignMd(input.frontMatter, input.body);
  await atomicWriteFile(paths.designMd(slug), nextText);
  const nextVersion = current.registry.version + 1;
  await atomicWriteFile(paths.versionDesignMd(slug, nextVersion), nextText);
  await updateEntry(registryFile, slug, { version: nextVersion, name: input.frontMatter.name });
  return readBrand(paths, registryFile, slug);
}

function parseDesignMd(raw: string): DesignMd {
  const parsed = matter(raw, {
    engines: {
      yaml: { parse: (s) => yaml.load(s) as object, stringify: (o) => yaml.dump(o) },
    },
  });
  return DesignMd.parse({ frontMatter: parsed.data, body: parsed.content.trimStart() });
}

export async function readBrandVersion(
  paths: BrandPaths,
  registryFile: string,
  slug: string,
  version: number,
): Promise<BrandWithDoc> {
  const current = await readBrand(paths, registryFile, slug);
  if (version === current.registry.version) return current;
  const raw = await readFile(paths.versionDesignMd(slug, version), 'utf8').catch(() => null);
  if (!raw) throw new Error(`Brand "${slug}" version ${version} not found`);
  return { registry: { ...current.registry, version }, doc: parseDesignMd(raw) };
}

export async function listBrandVersions(paths: BrandPaths, registryFile: string, slug: string): Promise<number[]> {
  const current = await readBrand(paths, registryFile, slug);
  const names = await readdir(paths.versionsDir(slug)).catch(() => []);
  const versions = names.flatMap((name) => {
    const match = /^v(\d+)\.design\.md$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
  versions.push(current.registry.version);
  return [...new Set(versions)].sort((a, b) => b - a);
}

export interface BrandValidation {
  valid: boolean;
  version: number;
  missingAssets: string[];
  fonts: string[];
}

export async function validateBrandVersion(
  paths: BrandPaths,
  registryFile: string,
  slug: string,
  version: number,
): Promise<BrandValidation> {
  const brand = await readBrandVersion(paths, registryFile, slug, version);
  const vpa = brand.doc.frontMatter.vpa;
  const referenced = [
    vpa?.logo.primary,
    vpa?.logo.mono,
    vpa?.audio.bumper_intro,
    vpa?.audio.bumper_outro,
    vpa?.audio.default_music_track,
    vpa?.audio.sonic_logo,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const missingAssets: string[] = [];
  for (const relative of referenced) {
    const absolute = join(paths.brandDir(slug), relative);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) missingAssets.push(relative);
  }
  const fonts = [...new Set(Object.values(brand.doc.frontMatter.typography).map((level) => level.fontFamily))];
  return { valid: missingAssets.length === 0, version, missingAssets, fonts };
}

export async function deleteBrand(
  paths: BrandPaths,
  registryFile: string,
  slug: string,
): Promise<void> {
  await rm(paths.brandDir(slug), { recursive: true, force: true });
  await removeEntry(registryFile, slug);
}

export async function listBrands(registryFile: string): Promise<BrandRegistry> {
  return readRegistry(registryFile);
}

function serializeDesignMd(fm: DesignMdFrontMatter, body: string): string {
  const yamlText = yaml.dump(fm, { lineWidth: 100, noRefs: true });
  return `---\n${yamlText}---\n\n${body.trimStart()}\n`;
}
