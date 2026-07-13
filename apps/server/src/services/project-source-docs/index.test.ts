import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  registerFile,
  registerUrl,
  addText,
  extractPending,
  listDocs,
  readExtracted,
} from './index.js';
import { getReferenceContext } from './context.js';

let projectPath: string;

beforeEach(async () => {
  projectPath = await mkdtemp(path.join(tmpdir(), 'vpa-srcdocs-'));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe('source-docs register + background extract', () => {
  it('registers a non-passthrough file as "extracting" without running extraction', async () => {
    // A .pdf must NOT be extracted during register — that is the slow path we
    // are deferring. Registering only saves the original + a manifest stub.
    const doc = await registerFile(projectPath, {
      filename: 'guide.pdf',
      buffer: Buffer.from('%PDF-1.4 fake bytes'),
    });

    expect(doc.status).toBe('extracting');
    expect(doc.extractedChars).toBe(0);

    const docs = await listDocs(projectPath);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.status).toBe('extracting');

    // The extracted markdown does not exist yet — reading it must be safe.
    expect(await readExtracted(projectPath, docs[0]!)).toBe('');
  });

  it('registers a passthrough .txt inline as "ready"', async () => {
    // Passthrough formats are just a readFile — fast enough to do inline, so
    // they land "ready" with no background pass.
    const doc = await registerFile(projectPath, {
      filename: 'notes.txt',
      buffer: Buffer.from('hello reference world'),
    });

    expect(doc.status).toBe('ready');
    expect(doc.extractedChars).toBeGreaterThan(0);
    expect(await readExtracted(projectPath, doc)).toContain('hello reference world');
  });

  it('registers a URL as "extracting"', async () => {
    const doc = await registerUrl(projectPath, 'https://example.com/pricing', 'Pricing');
    expect(doc.kind).toBe('url');
    expect(doc.status).toBe('extracting');
    expect(doc.extractedChars).toBe(0);
  });

  it('extractPending flips an extracting doc to "ready" using the injected extractor', async () => {
    await registerFile(projectPath, {
      filename: 'guide.pdf',
      buffer: Buffer.from('%PDF fake'),
    });

    await extractPending(projectPath, {
      extractFn: async () => ({ markdown: '# Extracted content', extractor: 'markitdown' }),
    });

    const docs = await listDocs(projectPath);
    expect(docs[0]!.status).toBe('ready');
    expect(docs[0]!.extractedChars).toBe('# Extracted content'.length);
    expect(await readExtracted(projectPath, docs[0]!)).toBe('# Extracted content');
  });

  it('marks a doc "failed" (not throwing) when extraction errors', async () => {
    await registerFile(projectPath, {
      filename: 'bad.pdf',
      buffer: Buffer.from('x'),
    });

    // Must not reject — a failed extract is a per-doc status, not a crash.
    await extractPending(projectPath, {
      extractFn: async () => {
        throw new Error('markitdown boom');
      },
    });

    const docs = await listDocs(projectPath);
    expect(docs[0]!.status).toBe('failed');
    expect(docs[0]!.error).toContain('boom');
  });

  it('getReferenceContext skips docs that are not ready', async () => {
    await addText(projectPath, 'Ready reference text', 'ready-note'); // ready
    await registerFile(projectPath, { filename: 'pending.pdf', buffer: Buffer.from('x') }); // extracting

    const bundle = await getReferenceContext(projectPath);

    expect(bundle.docCount).toBe(1);
    expect(bundle.text).toContain('Ready reference text');
  });
});
