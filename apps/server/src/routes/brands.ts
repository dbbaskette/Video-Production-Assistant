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
    }).finally(() => {
      // Keep slug tracked — it will be in the registry after generate completes
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
      }).catch((err) => {
        jobQueue.fail(job.id, String(err));
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

      if (!field || !['primary', 'mono', 'other'].includes(field)) {
        return reply.code(400).send({ error: 'field must be "primary", "mono", or "other"' });
      }

      if (!fileData || !filename) {
        return reply.code(400).send({ error: 'file is required' });
      }

      // Save file to assets directory
      const assetsDir = paths.assetsDir(slug);
      await mkdir(assetsDir, { recursive: true });
      const destPath = join(assetsDir, filename);
      await writeFile(destPath, fileData);

      const relPath = `assets/${filename}`;

      // If primary or mono, update the vpa.logo in design.md
      if (field === 'primary' || field === 'mono') {
        const fm = current.doc.frontMatter;
        const defaultVpa = {
          voice: { tone: '', avoid: [] as string[] },
          audio: { music_mood: null, sonic_logo: null },
          logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
          lower_thirds: { template: 'bar-left-accent' as const, bg: '{colors.primary}', fg: '{colors.surface}' },
          taglines: [] as string[],
        };
        const vpa = fm.vpa ?? defaultVpa;
        const updatedVpa = {
          ...vpa,
          logo: { ...vpa.logo, [field]: relPath },
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
