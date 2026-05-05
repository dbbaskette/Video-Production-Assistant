/**
 * Project source-docs storage + retrieval.
 *
 * Layout (mirrors the brand source-docs pattern):
 *
 *   <project>/source-docs/
 *     manifest.json                        — list of doc records (metadata)
 *     originals/<safe-filename>            — raw uploaded file (or url-stub.txt)
 *     extracted/<safe-filename>.md         — markitdown / pdf-parse / readability output
 *
 * The manifest is the source of truth for the UI. Originals are kept so users
 * can re-extract or download. Extracted markdown is what the LLM sees.
 *
 * Used by every "creative" LLM call (ideation, scene description, script
 * generation, lower-thirds recommendation, dialog conversion, quality review)
 * via getReferenceContext() — see services/project-source-docs/context.ts.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { extract, type ExtractResult } from '../document-extract/index.js';

export type SourceDocKind = 'file' | 'url' | 'text';

export interface SourceDoc {
  id: string;
  kind: SourceDocKind;
  /** Display name — original filename, URL, or first ~60 chars of text. */
  name: string;
  /** Original filename relative to source-docs/originals/ (file kind only). */
  originalRel?: string;
  /** Extracted markdown filename relative to source-docs/extracted/. */
  extractedRel: string;
  /** Source URL (url kind only). */
  url?: string;
  /** Which extractor produced the markdown. */
  extractor: ExtractResult['extractor'];
  /** Number of characters of extracted markdown. Used for context budgeting. */
  extractedChars: number;
  uploadedAt: string;
}

export interface SourceDocsManifest {
  docs: SourceDoc[];
}

const MANIFEST_FILE = 'manifest.json';

function rootDir(projectPath: string): string {
  return join(projectPath, 'source-docs');
}
function originalsDir(projectPath: string): string {
  return join(rootDir(projectPath), 'originals');
}
function extractedDir(projectPath: string): string {
  return join(rootDir(projectPath), 'extracted');
}
function manifestPath(projectPath: string): string {
  return join(rootDir(projectPath), MANIFEST_FILE);
}

/** Make a filesystem-safe, collision-resistant name for a source-doc record. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 80) || 'doc';
}

async function ensureDirs(projectPath: string): Promise<void> {
  await mkdir(originalsDir(projectPath), { recursive: true });
  await mkdir(extractedDir(projectPath), { recursive: true });
}

export async function readManifest(projectPath: string): Promise<SourceDocsManifest> {
  try {
    const text = await readFile(manifestPath(projectPath), 'utf-8');
    const parsed = JSON.parse(text) as SourceDocsManifest;
    if (Array.isArray(parsed.docs)) return parsed;
  } catch { /* missing or malformed — fall through */ }
  return { docs: [] };
}

async function writeManifest(projectPath: string, manifest: SourceDocsManifest): Promise<void> {
  await ensureDirs(projectPath);
  await atomicWriteFile(manifestPath(projectPath), JSON.stringify(manifest, null, 2));
}

export async function listDocs(projectPath: string): Promise<SourceDoc[]> {
  const m = await readManifest(projectPath);
  return m.docs;
}

export async function readExtracted(projectPath: string, doc: SourceDoc): Promise<string> {
  const path = join(extractedDir(projectPath), doc.extractedRel);
  return readFile(path, 'utf-8');
}

// ── File upload ──────────────────────────────────────────────────────

export async function addFile(
  projectPath: string,
  input: { filename: string; buffer: Buffer },
): Promise<SourceDoc> {
  await ensureDirs(projectPath);

  const safe = safeName(input.filename);
  const id = `doc-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  // Keep extension on original so extractors can dispatch correctly
  const ext = extname(input.filename).toLowerCase();
  const originalName = `${id}${ext || ''}`;
  const originalAbs = join(originalsDir(projectPath), originalName);
  await writeFile(originalAbs, input.buffer);

  const result = await extract({ kind: 'file', path: originalAbs });
  const extractedName = `${id}.md`;
  await writeFile(join(extractedDir(projectPath), extractedName), result.markdown);

  const doc: SourceDoc = {
    id,
    kind: 'file',
    name: input.filename,
    originalRel: originalName,
    extractedRel: extractedName,
    extractor: result.extractor,
    extractedChars: result.markdown.length,
    uploadedAt: new Date().toISOString(),
  };

  const manifest = await readManifest(projectPath);
  manifest.docs.push(doc);
  await writeManifest(projectPath, manifest);

  // Also keep a sibling safe-name copy for human navigation in the originals
  // dir (best-effort; ignored on collision).
  try {
    const niceCopy = join(originalsDir(projectPath), `${safe}${ext}`);
    if (!(await exists(niceCopy))) {
      const buf = await readFile(originalAbs);
      await writeFile(niceCopy, buf);
    }
  } catch { /* not fatal */ }

  return doc;
}

async function exists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() || s.isDirectory();
  } catch {
    return false;
  }
}

// ── URL ingest ───────────────────────────────────────────────────────

export async function addUrl(projectPath: string, url: string, displayName?: string): Promise<SourceDoc> {
  await ensureDirs(projectPath);
  const id = `doc-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const result = await extract({ kind: 'url', url });
  const extractedName = `${id}.md`;
  await writeFile(join(extractedDir(projectPath), extractedName), result.markdown);

  const doc: SourceDoc = {
    id,
    kind: 'url',
    name: displayName || url,
    extractedRel: extractedName,
    url,
    extractor: result.extractor,
    extractedChars: result.markdown.length,
    uploadedAt: new Date().toISOString(),
  };
  const manifest = await readManifest(projectPath);
  manifest.docs.push(doc);
  await writeManifest(projectPath, manifest);
  return doc;
}

// ── Inline text ──────────────────────────────────────────────────────

export async function addText(
  projectPath: string,
  text: string,
  displayName: string,
): Promise<SourceDoc> {
  await ensureDirs(projectPath);
  const id = `doc-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const extractedName = `${id}.md`;
  await writeFile(join(extractedDir(projectPath), extractedName), text);

  const doc: SourceDoc = {
    id,
    kind: 'text',
    name: displayName || text.slice(0, 60),
    extractedRel: extractedName,
    extractor: 'passthrough',
    extractedChars: text.length,
    uploadedAt: new Date().toISOString(),
  };
  const manifest = await readManifest(projectPath);
  manifest.docs.push(doc);
  await writeManifest(projectPath, manifest);
  return doc;
}

// ── Delete ───────────────────────────────────────────────────────────

export async function deleteDoc(projectPath: string, docId: string): Promise<boolean> {
  const manifest = await readManifest(projectPath);
  const doc = manifest.docs.find((d) => d.id === docId);
  if (!doc) return false;

  if (doc.originalRel) {
    await rm(join(originalsDir(projectPath), doc.originalRel), { force: true });
  }
  await rm(join(extractedDir(projectPath), doc.extractedRel), { force: true });

  manifest.docs = manifest.docs.filter((d) => d.id !== docId);
  await writeManifest(projectPath, manifest);
  return true;
}

export { basename, extname };
