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

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { extract, type ExtractInput, type ExtractResult } from '../document-extract/index.js';

export type SourceDocKind = 'file' | 'url' | 'text';

/**
 * Extraction lifecycle for a doc:
 *   - 'extracting': registered (original saved) but markitdown/readability
 *     hasn't run yet — happens in a detached background pass so `create`
 *     and uploads return instantly.
 *   - 'ready': extracted markdown is on disk and usable as LLM context.
 *   - 'failed': extraction errored; `error` carries the reason.
 * Legacy docs written before this field existed have no `status` and are
 * treated as 'ready' everywhere (they always had their extract on disk).
 */
export type SourceDocStatus = 'extracting' | 'ready' | 'failed';

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
  /** Extraction lifecycle — absent on legacy docs (treat as 'ready'). */
  status?: SourceDocStatus;
  /** Failure reason when status === 'failed'. */
  error?: string;
  uploadedAt: string;
}

/** A doc counts as usable context only once its markdown is on disk. */
export function isReady(doc: SourceDoc): boolean {
  return (doc.status ?? 'ready') === 'ready';
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
  try {
    return await readFile(path, 'utf-8');
  } catch {
    // A doc that's still 'extracting' (or whose extract failed) has no
    // markdown on disk yet. Return empty rather than throwing so callers
    // that read opportunistically (e.g. the GET :docId preview) don't 500.
    return '';
  }
}

/**
 * Read-modify-write a single doc's manifest entry. Used by the background
 * extraction pass to flip status without clobbering concurrently-registered
 * docs. Callers must serialize per project (see `extractPending`) so two
 * updates don't interleave their read/write.
 */
async function updateDoc(
  projectPath: string,
  docId: string,
  patch: Partial<SourceDoc>,
): Promise<void> {
  const manifest = await readManifest(projectPath);
  const doc = manifest.docs.find((d) => d.id === docId);
  if (!doc) return;
  Object.assign(doc, patch);
  await writeManifest(projectPath, manifest);
}

// ── File upload ──────────────────────────────────────────────────────

/** Formats we can extract with a plain readFile — fast enough to do inline. */
const PASSTHROUGH_EXTS = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml']);

/**
 * Save an uploaded file and record a manifest entry, WITHOUT running the
 * slow extractor. Passthrough formats (.md/.txt/…) are cheap so they're
 * extracted inline and land 'ready'; everything else is left 'extracting'
 * for the background pass (`extractPending`) to finish.
 *
 * This is the fast half of what used to be `addFile` — it's what the upload
 * route awaits, so create/upload returns in milliseconds instead of blocking
 * on markitdown's Python startup + PDF parsing.
 */
export async function registerFile(
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

  const extractedName = `${id}.md`;
  const isPassthrough = PASSTHROUGH_EXTS.has(ext);

  const doc: SourceDoc = {
    id,
    kind: 'file',
    name: input.filename,
    originalRel: originalName,
    extractedRel: extractedName,
    // Passthrough resolves below; non-passthrough stays a stub until extracted.
    extractor: isPassthrough ? 'passthrough' : 'markitdown',
    extractedChars: 0,
    status: 'extracting',
    uploadedAt: new Date().toISOString(),
  };

  if (isPassthrough) {
    // Cheap path — read + store now so it's immediately usable.
    const result = await extract({ kind: 'file', path: originalAbs });
    await writeFile(join(extractedDir(projectPath), extractedName), result.markdown);
    doc.extractor = result.extractor;
    doc.extractedChars = result.markdown.length;
    doc.status = 'ready';
  }

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

/**
 * Register a URL doc WITHOUT fetching it. The fetch + readability extraction
 * runs in the background pass, same as non-passthrough files.
 */
export async function registerUrl(
  projectPath: string,
  url: string,
  displayName?: string,
): Promise<SourceDoc> {
  await ensureDirs(projectPath);
  const id = `doc-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const extractedName = `${id}.md`;

  const doc: SourceDoc = {
    id,
    kind: 'url',
    name: displayName || url,
    extractedRel: extractedName,
    url,
    extractor: 'readability',
    extractedChars: 0,
    status: 'extracting',
    uploadedAt: new Date().toISOString(),
  };
  const manifest = await readManifest(projectPath);
  manifest.docs.push(doc);
  await writeManifest(projectPath, manifest);
  return doc;
}

// ── Background extraction ─────────────────────────────────────────────

export interface ExtractPendingOptions {
  /** Injectable extractor for tests; defaults to the real `extract`. */
  extractFn?: (input: ExtractInput) => Promise<ExtractResult>;
}

/**
 * Extract every doc still in the 'extracting' state, sequentially, flipping
 * each to 'ready' (or 'failed' with a reason). Sequential + per-project
 * serialized (via `scheduleExtraction`) so the read-modify-write manifest
 * updates never race.
 *
 * Awaitable so tests can drive it deterministically; the route fires it
 * through `scheduleExtraction` and does not await.
 */
export async function extractPending(
  projectPath: string,
  opts: ExtractPendingOptions = {},
): Promise<void> {
  const extractFn = opts.extractFn ?? ((input: ExtractInput) => extract(input));
  const manifest = await readManifest(projectPath);
  const pending = manifest.docs.filter((d) => d.status === 'extracting');

  for (const doc of pending) {
    const input: ExtractInput | null =
      doc.kind === 'file' && doc.originalRel
        ? { kind: 'file', path: join(originalsDir(projectPath), doc.originalRel) }
        : doc.kind === 'url' && doc.url
          ? { kind: 'url', url: doc.url }
          : null;
    if (!input) {
      await updateDoc(projectPath, doc.id, { status: 'failed', error: 'Nothing to extract' });
      continue;
    }
    try {
      const result = await extractFn(input);
      await writeFile(join(extractedDir(projectPath), doc.extractedRel), result.markdown);
      await updateDoc(projectPath, doc.id, {
        status: 'ready',
        error: undefined,
        extractor: result.extractor,
        extractedChars: result.markdown.length,
      });
    } catch (err) {
      await updateDoc(projectPath, doc.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Per-project promise chain so concurrent uploads don't run overlapping
 *  extraction passes (which would race on the manifest). */
const extractionChains = new Map<string, Promise<void>>();

/**
 * Fire-and-forget the background extraction for a project. Chains behind any
 * in-flight pass for the same project and swallows errors (per-doc failures
 * are already captured on the manifest). Returns the promise so callers/tests
 * can await if they want to.
 */
export function scheduleExtraction(projectPath: string): Promise<void> {
  const prev = extractionChains.get(projectPath) ?? Promise.resolve();
  const next = prev.then(() => extractPending(projectPath)).catch(() => {});
  extractionChains.set(projectPath, next);
  // Once this link settles and nothing newer replaced it, drop the entry.
  next.finally(() => {
    if (extractionChains.get(projectPath) === next) extractionChains.delete(projectPath);
  });
  return next;
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
    status: 'ready',
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
