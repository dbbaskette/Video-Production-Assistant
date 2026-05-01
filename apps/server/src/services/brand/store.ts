import { mkdir, readFile, rm } from 'node:fs/promises';
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
  await atomicWriteFile(paths.designMd(slug), serializeDesignMd(input.frontMatter, input.body));
  const nextVersion = current.registry.version + 1;
  await updateEntry(registryFile, slug, { version: nextVersion, name: input.frontMatter.name });
  return readBrand(paths, registryFile, slug);
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
