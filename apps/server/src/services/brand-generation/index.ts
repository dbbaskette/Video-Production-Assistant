import { mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import { extract } from '../document-extract/index.js';
import type { ExtractInput } from '../document-extract/index.js';
import { JobQueue } from '../../lib/job-queue.js';
import type { BrandPaths } from '../brand/paths.js';
import { createBrand, readBrand, updateBrandDoc } from '../brand/store.js';
import { extractTokens } from './extract-tokens.js';
import { writeRationale } from './write-rationale.js';
import type { DesignMdFrontMatter } from '@vpa/shared';

export interface BrandExtractJobInput {
  jobId: string;
  queue: JobQueue;
  paths: BrandPaths;
  registryFile: string;
  workspaceRoot: string;
  llm: LlmClient;
  slug: string;
  brandName: string;
  sources: ExtractInput[];
}

export async function runBrandExtractJob(input: BrandExtractJobInput): Promise<void> {
  const { jobId, queue, paths, workspaceRoot, llm, slug, brandName, sources } = input;
  try {
    queue.setStatus(jobId, 'running');

    await mkdir(paths.sourceDocsDir(slug), { recursive: true });

    const urls = sources.filter((s): s is Extract<ExtractInput, { kind: 'url' }> => s.kind === 'url').map((s) => s.url);
    const free = sources.filter((s): s is Extract<ExtractInput, { kind: 'text' }> => s.kind === 'text').map((s) => s.text);
    await writeFile(
      paths.sourcesJson(slug),
      JSON.stringify({ urls, free_text: free.join('\n\n---\n\n') }, null, 2) + '\n',
      'utf8',
    );
    queue.emit(jobId, 'persisted', { sources: sources.length });

    const chunks: string[] = [];
    for (const src of sources) {
      const label = src.kind === 'file' ? basename(src.path) : src.kind === 'url' ? src.url : '<free-text>';
      queue.emit(jobId, 'extracting', { source: label });
      const out = await extract(src);
      chunks.push(`<!-- source: ${label} (${out.extractor}) -->\n\n${out.markdown}`);
      queue.emit(jobId, 'extracted', { source: label, bytes: out.markdown.length });
    }
    const combined = chunks.join('\n\n---\n\n');
    await writeFile(paths.extractedTextMd(slug), combined, 'utf8');

    const MAX_LLM_INPUT = 200_000;
    let llmInput = combined;
    if (combined.length > MAX_LLM_INPUT) {
      llmInput = combined.slice(0, MAX_LLM_INPUT);
      queue.emit(jobId, 'truncated', { original: combined.length, truncated: MAX_LLM_INPUT });
    }

    queue.emit(jobId, 'extracting-tokens');
    const sysPrompt = await loadPrompt(workspaceRoot, 'brand-extract-tokens');
    const tokens = await extractTokens(llm, {
      systemPrompt: sysPrompt,
      sourceMarkdown: llmInput,
      brandName,
    });

    queue.setStatus(jobId, 'awaiting-input');
    queue.emit(jobId, 'tokens-ready', { frontMatter: tokens.frontMatter });
  } catch (err: any) {
    queue.fail(jobId, err.message ?? String(err));
  }
}

export interface BrandGenerateJobInput {
  jobId: string;
  queue: JobQueue;
  paths: BrandPaths;
  registryFile: string;
  workspaceRoot: string;
  llm: LlmClient;
  slug: string;
  brandName: string;
  frontMatter: DesignMdFrontMatter;
  isUpdate?: boolean;
}

export async function runBrandGenerateJob(input: BrandGenerateJobInput): Promise<void> {
  const { jobId, queue, paths, registryFile, workspaceRoot, llm, slug, brandName, frontMatter, isUpdate } = input;
  try {
    queue.setStatus(jobId, 'running');

    queue.emit(jobId, 'writing-rationale');
    const sysPrompt = await loadPrompt(workspaceRoot, 'brand-write-rationale');
    const body = await writeRationale(llm, { systemPrompt: sysPrompt, frontMatter });

    if (isUpdate) {
      await updateBrandDoc(paths, registryFile, slug, { frontMatter, body });
    } else {
      await createBrand(paths, registryFile, { slug, name: brandName, frontMatter, body });
    }
    const persisted = await readBrand(paths, registryFile, slug);

    queue.complete(jobId, { brand_slug: slug, version: persisted.registry.version });
  } catch (err: any) {
    queue.fail(jobId, err.message ?? String(err));
  }
}
