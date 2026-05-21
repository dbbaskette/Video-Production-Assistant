import { createReadStream } from 'node:fs';
import { writeFile, mkdir, stat, readFile as fsReadFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BrandPaths } from '../services/brand/paths.js';
import { jobQueue } from '../lib/job-queue.js';
import { listBrands, readBrand, deleteBrand, updateBrandDoc } from '../services/brand/store.js';
import { runBrandExtractJob, runBrandGenerateJob } from '../services/brand-generation/index.js';
import type { ExtractInput } from '../services/document-extract/index.js';
import type { LlmClient } from '../services/llm/index.js';
import { DesignMdFrontMatter, ProjectTrackerSchema, ProjectSchema } from '@vpa/shared';
import { forkBrand } from '../services/brand/fork.js';
import { setDefault } from '../services/brand/registry.js';
import { extractTokens } from '../services/brand-generation/extract-tokens.js';
import { loadPrompt } from '../services/llm/prompts.js';

export interface BrandRouteOptions {
  paths: BrandPaths;
  registryFile: string;
  workspaceRoot: string;
  trackerPath?: string;
  llm: LlmClient;
}

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.md', '.markdown', '.txt']);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

interface ReferencingProject {
  id: string;
  name: string;
  path: string;
}

async function listReferencingProjects(
  trackerFilePath: string,
  brandSlug: string,
): Promise<ReferencingProject[]> {
  let trackerRaw: string;
  try {
    trackerRaw = await fsReadFile(trackerFilePath, 'utf8');
  } catch {
    return [];
  }
  const tracker = ProjectTrackerSchema.parse(JSON.parse(trackerRaw));
  const results: ReferencingProject[] = [];
  for (const entry of tracker.projects) {
    try {
      const yamlText = await fsReadFile(join(entry.path, 'project.yaml'), 'utf8');
      const yaml = await import('js-yaml');
      const raw = yaml.default.load(yamlText, { schema: yaml.default.CORE_SCHEMA }) as Record<string, unknown>;
      const project = ProjectSchema.safeParse(raw);
      if (project.success && project.data.brand?.id === brandSlug) {
        results.push({ id: entry.id, name: entry.name, path: entry.path });
      }
    } catch {
      // Skip projects that can't be read
    }
  }
  return results;
}

export async function registerBrandRoutes(
  app: FastifyInstance,
  opts: BrandRouteOptions,
): Promise<void> {
  const { paths, registryFile, workspaceRoot, llm } = opts;

  // Track slugs that have an active extract job (to prevent duplicates before brand is persisted)
  const pendingSlugs = new Set<string>();

  // ──────────────────── GET /api/brands ────────────────────
  app.get('/api/brands', async (_req, reply) => {
    const registry = await listBrands(registryFile);
    return registry;
  });

  // ──────────────────── POST /api/brands ────────────────────
  app.post('/api/brands', async (req, reply) => {
    let name: string | undefined;
    let freeText: string | undefined;
    let url: string | undefined;
    const fileSources: ExtractInput[] = [];

    if (req.isMultipart()) {
      // Handle multipart form data
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field') {
          const val = typeof part.value === 'string' ? part.value : String(part.value ?? '');
          if (part.fieldname === 'name') name = val;
          else if (part.fieldname === 'free_text') freeText = val;
          else if (part.fieldname === 'url') url = val;
        } else if (part.type === 'file') {
          const ext = extname(part.filename ?? '').toLowerCase();
          if (!ALLOWED_EXTENSIONS.has(ext)) {
            return reply.code(400).send({
              error: `Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
            });
          }
          // Write file to temp upload dir
          const uploadDir = join(paths.brandsRoot, '_uploads');
          await mkdir(uploadDir, { recursive: true });
          const destFile = join(uploadDir, `${Date.now()}-${basename(part.filename ?? 'file')}`);
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          await writeFile(destFile, Buffer.concat(chunks));
          fileSources.push({ kind: 'file', path: destFile });
        }
      }
    } else {
      // Handle JSON body
      const body = req.body as Record<string, unknown> | null | undefined;
      if (body) {
        name = typeof body.name === 'string' ? body.name : undefined;
        freeText = typeof body.free_text === 'string' ? body.free_text : undefined;
        url = typeof body.url === 'string' ? body.url : undefined;
      }
    }

    // Validate: name required
    if (!name || name.trim().length === 0) {
      return reply.code(400).send({ error: 'name is required' });
    }

    // Build sources
    const sources: ExtractInput[] = [...fileSources];
    if (freeText) sources.push({ kind: 'text', text: freeText });
    if (url) sources.push({ kind: 'url', url });

    // Validate: at least one source
    if (sources.length === 0) {
      return reply.code(400).send({ error: 'At least one source (free_text, url, or file) is required' });
    }

    const slug = slugify(name);

    // Check for duplicate slug
    const existing = await listBrands(registryFile);
    if (existing.brands.some((b) => b.id === slug) || pendingSlugs.has(slug)) {
      return reply.code(409).send({ error: `Brand "${slug}" already exists` });
    }

    // Create job
    const job = jobQueue.create('brand.extract');
    pendingSlugs.add(slug);

    // Fire-and-forget extract
    runBrandExtractJob({
      jobId: job.id,
      queue: jobQueue,
      paths,
      registryFile,
      workspaceRoot,
      llm,
      slug,
      brandName: name,
      sources,
    }).catch((err) => {
      jobQueue.fail(job.id, String(err));
      pendingSlugs.delete(slug);
    });

    return reply.code(202).send({ job_id: job.id, slug });
  });

  // ──────────────────── POST /api/brands/:slug/generate ────────────────────
  app.post<{ Params: { slug: string } }>(
    '/api/brands/:slug/generate',
    async (req, reply) => {
      const { slug } = req.params;
      const body = req.body as Record<string, unknown> | null | undefined;
      const rawFrontMatter = body?.front_matter;

      if (!rawFrontMatter) {
        return reply.code(400).send({ error: 'front_matter is required' });
      }

      const parsed = DesignMdFrontMatter.safeParse(rawFrontMatter);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid front_matter',
          details: parsed.error.issues,
        });
      }

      const job = jobQueue.create('brand.generate');

      runBrandGenerateJob({
        jobId: job.id,
        queue: jobQueue,
        paths,
        registryFile,
        workspaceRoot,
        llm,
        slug,
        brandName: parsed.data.name,
        frontMatter: parsed.data,
      }).then(() => {
        // Brand is in the registry now — safe to remove from pending
        pendingSlugs.delete(slug);
      }).catch((err) => {
        jobQueue.fail(job.id, String(err));
        pendingSlugs.delete(slug);
      });

      return reply.code(202).send({ job_id: job.id });
    },
  );

  // ──────────────────── GET /api/brands/:slug ────────────────────
  app.get<{ Params: { slug: string } }>(
    '/api/brands/:slug',
    async (req, reply) => {
      const { slug } = req.params;
      try {
        const brand = await readBrand(paths, registryFile, slug);
        return brand;
      } catch (err: any) {
        if (err.message?.includes('not found')) {
          return reply.code(404).send({ error: `Brand "${slug}" not found` });
        }
        throw err;
      }
    },
  );

  // ──────────────────── GET /api/brands/:slug/download ────────────────────
  // Markdown-only download (preserved for backwards compat / quick access).
  // The frontend uses the zip endpoint below by default.
  app.get<{ Params: { slug: string } }>(
    '/api/brands/:slug/download',
    async (req, reply) => {
      const { slug } = req.params;
      const designPath = paths.designMd(slug);

      try {
        await stat(designPath);
      } catch {
        return reply.code(404).send({ error: `Brand "${slug}" design.md not found` });
      }

      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${slug}-design.md"`);
      return reply.send(createReadStream(designPath));
    },
  );

  // ──────────────────── GET /api/brands/:slug/download.zip ────────────────────
  // Bundles the entire brand directory (design.md + parent.json + assets/)
  // into a zip and streams it back. We shell out to the system `zip` binary
  // — already a dependency of macOS / common Linux distros, avoids pulling
  // in a Node zip library. The zip is built in a tmp file, streamed, and
  // unlinked when the response finishes.
  app.get<{ Params: { slug: string } }>(
    '/api/brands/:slug/download.zip',
    async (req, reply) => {
      const { slug } = req.params;
      try {
        await readBrand(paths, registryFile, slug);
      } catch {
        return reply.code(404).send({ error: `Brand "${slug}" not found` });
      }
      const brandDir = paths.brandDir(slug);
      try {
        const s = await stat(brandDir);
        if (!s.isDirectory()) {
          return reply.code(404).send({ error: `Brand directory missing for "${slug}"` });
        }
      } catch {
        return reply.code(404).send({ error: `Brand directory missing for "${slug}"` });
      }

      const { tmpdir } = await import('node:os');
      const { randomUUID } = await import('node:crypto');
      const { execFile } = await import('node:child_process');
      const { unlink } = await import('node:fs/promises');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const zipPath = join(tmpdir(), `vpa-brand-${slug}-${randomUUID()}.zip`);
      try {
        // `zip -r -q out.zip BRAND_FOLDER` — recursive, quiet. We cd into the
        // parent of brandDir so the archive's top-level entry is the brand
        // slug, not the full filesystem path.
        const parentDir = join(brandDir, '..');
        const folderName = slug;
        await execFileAsync('zip', ['-r', '-q', zipPath, folderName], {
          cwd: parentDir,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await unlink(zipPath).catch(() => {});
        return reply.code(500).send({ error: `Failed to build zip: ${msg}` });
      }

      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${slug}-brand.zip"`);
      const stream = createReadStream(zipPath);
      stream.on('close', () => {
        // Best-effort cleanup once the file has been streamed (or the client
        // disconnected). We don't await — the response has already been sent.
        unlink(zipPath).catch(() => {});
      });
      return reply.send(stream);
    },
  );

  // ──────────────────── POST /api/brands/:slug/fork ────────────────────
  app.post<{ Params: { slug: string } }>(
    '/api/brands/:slug/fork',
    async (req, reply) => {
      const { slug: parentSlug } = req.params;
      const body = req.body as Record<string, unknown> | null | undefined;
      const name = typeof body?.name === 'string' ? body.name.trim() : '';

      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }

      try {
        const forked = await forkBrand(paths, registryFile, parentSlug, { name });
        return reply.code(201).send(forked);
      } catch (err: any) {
        if (err.message?.includes('not found')) {
          return reply.code(404).send({ error: `Brand "${parentSlug}" not found` });
        }
        throw err;
      }
    },
  );

  // ──────────────────── PUT /api/brands/:slug ────────────────────
  app.put<{ Params: { slug: string } }>(
    '/api/brands/:slug',
    async (req, reply) => {
      const { slug } = req.params;
      const body = req.body as Record<string, unknown> | null | undefined;

      if (!body) {
        return reply.code(400).send({ error: 'Request body is required' });
      }

      // Mode 1: toggle default
      if ('is_default' in body) {
        try {
          if (body.is_default) {
            await setDefault(registryFile, slug);
          } else {
            await setDefault(registryFile, null);
          }
          const brand = await readBrand(paths, registryFile, slug);
          return reply.code(200).send(brand);
        } catch (err: any) {
          if (err.message?.includes('not found')) {
            return reply.code(404).send({ error: `Brand "${slug}" not found` });
          }
          throw err;
        }
      }

      // Mode 2: update document
      if ('front_matter' in body && 'body' in body) {
        const parsed = DesignMdFrontMatter.safeParse(body.front_matter);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'Invalid front_matter',
            details: parsed.error.issues,
          });
        }
        try {
          const updated = await updateBrandDoc(paths, registryFile, slug, {
            frontMatter: parsed.data,
            body: typeof body.body === 'string' ? body.body : '',
          });
          return reply.code(200).send(updated);
        } catch (err: any) {
          if (err.message?.includes('not found')) {
            return reply.code(404).send({ error: `Brand "${slug}" not found` });
          }
          throw err;
        }
      }

      return reply.code(400).send({ error: 'Body must contain either { is_default } or { front_matter, body }' });
    },
  );

  // ──────────────────── POST /api/brands/:slug/regenerate ────────────────────
  app.post<{ Params: { slug: string } }>(
    '/api/brands/:slug/regenerate',
    async (req, reply) => {
      const { slug } = req.params;
      let current;
      try {
        current = await readBrand(paths, registryFile, slug);
      } catch {
        return reply.code(404).send({ error: `Brand "${slug}" not found` });
      }

      let cached: string;
      try {
        cached = await fsReadFile(paths.extractedTextMd(slug), 'utf8');
      } catch {
        return reply.code(409).send({ error: 'No cached extraction available; resubmit sources' });
      }

      const job = jobQueue.create('brand.regenerate');

      (async () => {
        try {
          jobQueue.setStatus(job.id, 'running');
          const sysPrompt = await loadPrompt(workspaceRoot, 'brand-extract-tokens');
          const tokens = await extractTokens(llm, {
            systemPrompt: sysPrompt,
            sourceMarkdown: cached,
            brandName: current.registry.name,
          });
          const nextFm = {
            ...tokens.frontMatter,
            name: current.registry.name,
          };
          await runBrandGenerateJob({
            jobId: job.id,
            queue: jobQueue,
            paths,
            registryFile,
            workspaceRoot,
            llm,
            slug,
            brandName: current.registry.name,
            frontMatter: nextFm,
            isUpdate: true,
          });
        } catch (err: any) {
          jobQueue.fail(job.id, err.message ?? String(err));
        }
      })();

      return reply.code(202).send({ job_id: job.id });
    },
  );

  // ──────────────────── GET /api/brands/:slug/assets/:filename ───────────
  // Wildcard so we can serve assets in subdirectories (e.g. bumpers/intro.mp4).
  // The pre-existing single-segment route still matches `assets/foo.png` and is
  // kept for backwards compat; this catches deeper paths like
  // `assets/bumpers/intro.mp4`.
  app.get<{ Params: { slug: string; filename: string } }>(
    '/api/brands/:slug/assets/:filename',
    async (req, reply) => {
      const { slug, filename: fname } = req.params;
      const filePath = join(paths.assetsDir(slug), fname);
      try {
        await stat(filePath);
      } catch {
        return reply.code(404).send({ error: 'Asset not found' });
      }
      const ext = extname(fname).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
      };
      reply.header('Content-Type', mimeMap[ext] ?? 'application/octet-stream');
      return reply.send(createReadStream(filePath));
    },
  );

  // Subpath variant — serves assets from sub-folders (bumpers/, music/, etc.).
  // Bare `/assets/:filename` only matches one segment, so this catches the rest.
  app.get<{ Params: { slug: string; '*': string } }>(
    '/api/brands/:slug/assets/*',
    async (req, reply) => {
      const { slug } = req.params;
      // Reconstruct the wildcard portion — fastify exposes it on req.params['*'].
      const rest = (req.params as Record<string, string | undefined>)['*'] ?? '';
      // Reject any traversal attempts.
      if (!rest || rest.includes('..')) {
        return reply.code(400).send({ error: 'Invalid path' });
      }
      const filePath = join(paths.assetsDir(slug), rest);
      try {
        await stat(filePath);
      } catch {
        return reply.code(404).send({ error: 'Asset not found' });
      }
      const ext = extname(rest).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
      };
      reply.header('Content-Type', mimeMap[ext] ?? 'application/octet-stream');
      return reply.send(createReadStream(filePath));
    },
  );

  // ──────────────────── POST /api/brands/:slug/assets ────────────────────
  app.post<{ Params: { slug: string } }>(
    '/api/brands/:slug/assets',
    async (req, reply) => {
      const { slug } = req.params;

      // Verify brand exists
      let current;
      try {
        current = await readBrand(paths, registryFile, slug);
      } catch {
        return reply.code(404).send({ error: `Brand "${slug}" not found` });
      }

      if (!req.isMultipart()) {
        return reply.code(400).send({ error: 'Multipart form data required' });
      }

      let field: string | undefined;
      let filename: string | undefined;
      let fileData: Buffer | undefined;

      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'field') {
          field = typeof part.value === 'string' ? part.value : String(part.value ?? '');
        } else if (part.type === 'file') {
          filename = part.filename ?? 'upload';
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          fileData = Buffer.concat(chunks);
        }
      }

      // Asset categories — each maps to a subdirectory under assets/ and
      // updates a different field in the brand's vpa.* front-matter.
      const FIELD_CONFIG: Record<
        string,
        { subdir: string; updates: 'logo.primary' | 'logo.mono' | 'audio.bumper_intro' | 'audio.bumper_outro' | 'audio.default_music_track' | 'audio.sonic_logo' | 'none' }
      > = {
        primary: { subdir: '', updates: 'logo.primary' },
        mono: { subdir: '', updates: 'logo.mono' },
        'bumper-intro': { subdir: 'bumpers', updates: 'audio.bumper_intro' },
        'bumper-outro': { subdir: 'bumpers', updates: 'audio.bumper_outro' },
        'default-music': { subdir: 'music', updates: 'audio.default_music_track' },
        'sonic-logo': { subdir: 'sounds', updates: 'audio.sonic_logo' },
        other: { subdir: '', updates: 'none' },
      };
      const cfg = field ? FIELD_CONFIG[field] : undefined;
      if (!cfg) {
        return reply.code(400).send({
          error: `field must be one of: ${Object.keys(FIELD_CONFIG).join(', ')}`,
        });
      }

      if (!fileData || !filename) {
        return reply.code(400).send({ error: 'file is required' });
      }

      // Save file to assets directory (or subdirectory for video/audio assets).
      const assetsDir = paths.assetsDir(slug);
      const destDir = cfg.subdir ? join(assetsDir, cfg.subdir) : assetsDir;
      await mkdir(destDir, { recursive: true });
      // Sanitise the filename — keep alphanumerics, dash, underscore, dot.
      // Prevents shell-special chars and ensures the path round-trips through
      // URLs cleanly.
      const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 200) || 'upload';
      const destPath = join(destDir, safeName);
      await writeFile(destPath, fileData);

      const relPath = cfg.subdir ? `assets/${cfg.subdir}/${safeName}` : `assets/${safeName}`;

      // Update the relevant vpa.* field in design.md if this asset's category
      // is tied to one. `other` uploads are free-form and don't touch the
      // front-matter; the user can reference them manually.
      if (cfg.updates !== 'none') {
        const fm = current.doc.frontMatter;
        const defaultVpa = {
          voice: { tone: '', avoid: [] as string[] },
          audio: {
            music_mood: null,
            sonic_logo: null,
            bumper_intro: null,
            bumper_outro: null,
            default_music_track: null,
          },
          logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
          lower_thirds: { template: 'bar-left-accent' as const, bg: '{colors.primary}', fg: '{colors.surface}' },
          taglines: [] as string[],
        };
        const vpa = fm.vpa ?? defaultVpa;
        const [group, key] = cfg.updates.split('.') as ['logo' | 'audio', string];
        const updatedVpa = {
          ...vpa,
          [group]: { ...(vpa[group] ?? defaultVpa[group]), [key]: relPath },
        };
        const nextFm = {
          ...fm,
          vpa: updatedVpa,
        };
        await updateBrandDoc(paths, registryFile, slug, {
          frontMatter: nextFm,
          body: current.doc.body,
        });
      }

      return reply.code(201).send({ path: relPath });
    },
  );

  // ──────────────────── DELETE /api/brands/:slug/assets/* ────────────────────
  // Clear a brand asset by category. Removes the front-matter pointer and the
  // file on disk. Used by the "Remove" button next to each uploadable slot in
  // the Brand Assets tab.
  app.delete<{ Params: { slug: string }; Querystring: { field?: string } }>(
    '/api/brands/:slug/assets',
    async (req, reply) => {
      const { slug } = req.params;
      const field = req.query.field;
      const FIELD_TO_PATH: Record<string, ['logo' | 'audio', string]> = {
        primary: ['logo', 'primary'],
        mono: ['logo', 'mono'],
        'bumper-intro': ['audio', 'bumper_intro'],
        'bumper-outro': ['audio', 'bumper_outro'],
        'default-music': ['audio', 'default_music_track'],
        'sonic-logo': ['audio', 'sonic_logo'],
      };
      const target = field ? FIELD_TO_PATH[field] : undefined;
      if (!target) {
        return reply.code(400).send({
          error: `field must be one of: ${Object.keys(FIELD_TO_PATH).join(', ')}`,
        });
      }
      let current;
      try {
        current = await readBrand(paths, registryFile, slug);
      } catch {
        return reply.code(404).send({ error: `Brand "${slug}" not found` });
      }
      const fm = current.doc.frontMatter;
      const vpa = fm.vpa;
      if (!vpa) return reply.send({ cleared: true });
      const [group, key] = target;
      const groupObj = vpa[group] as Record<string, unknown> | undefined;
      const currentPath = groupObj?.[key];
      const updatedGroup = { ...(groupObj ?? {}), [key]: null };
      await updateBrandDoc(paths, registryFile, slug, {
        frontMatter: { ...fm, vpa: { ...vpa, [group]: updatedGroup } },
        body: current.doc.body,
      });
      // Best-effort delete the file too — we don't want orphaned bumpers on
      // disk. Failure is harmless (front-matter pointer is gone, render won't
      // find it).
      if (typeof currentPath === 'string' && currentPath.startsWith('assets/')) {
        try {
          const abs = join(paths.assetsDir(slug), currentPath.replace(/^assets\//, ''));
          const { unlink } = await import('node:fs/promises');
          await unlink(abs).catch(() => {});
        } catch { /* ignore */ }
      }
      return reply.send({ cleared: true });
    },
  );

  // ──────────────────── GET /api/brands/:slug/projects ────────────────────
  // Lists every project whose project.yaml has brand.id === slug. Powers the
  // brand-detail "Usage" tab. Quietly returns [] when there's no tracker
  // configured rather than 500-ing — the Usage tab handles that.
  app.get<{ Params: { slug: string } }>(
    '/api/brands/:slug/projects',
    async (req, reply) => {
      const { slug } = req.params;
      try {
        await readBrand(paths, registryFile, slug);
      } catch {
        return reply.code(404).send({ error: `Brand "${slug}" not found` });
      }
      const trackerFile = opts.trackerPath;
      if (!trackerFile) return reply.send({ projects: [] });
      const projects = await listReferencingProjects(trackerFile, slug);
      return reply.send({ projects });
    },
  );

  // ──────────────────── DELETE /api/brands/:slug ────────────────────
  app.delete<{ Params: { slug: string }; Querystring: { force?: string } }>(
    '/api/brands/:slug',
    async (req, reply) => {
      const { slug } = req.params;
      const force = req.query.force === 'true';

      // Verify brand exists before deletion
      const existing = await listBrands(registryFile);
      if (!existing.brands.some((b) => b.id === slug)) {
        return reply.code(404).send({ error: `Brand "${slug}" not found` });
      }

      // Project-reference guard
      if (opts.trackerPath && !force) {
        const refs = await listReferencingProjects(opts.trackerPath, slug);
        if (refs.length > 0) {
          return reply.code(409).send({
            error: `Brand "${slug}" is referenced by ${refs.length} project(s)`,
            referencing_projects: refs,
          });
        }
      }

      await deleteBrand(paths, registryFile, slug);
      pendingSlugs.delete(slug);
      return reply.code(204).send();
    },
  );
}
