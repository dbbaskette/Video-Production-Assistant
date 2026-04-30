import { createReadStream } from 'node:fs';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BrandPaths } from '../services/brand/paths.js';
import { jobQueue } from '../lib/job-queue.js';
import { listBrands, readBrand, deleteBrand } from '../services/brand/store.js';
import { runBrandExtractJob, runBrandGenerateJob } from '../services/brand-generation/index.js';
import type { ExtractInput } from '../services/document-extract/index.js';
import { createFakeLlm } from '../services/llm/fake.js';
import { DesignMdFrontMatter } from '@vpa/shared';

export interface BrandRouteOptions {
  paths: BrandPaths;
  registryFile: string;
  workspaceRoot: string;
}

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.md', '.markdown', '.txt']);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function registerBrandRoutes(
  app: FastifyInstance,
  opts: BrandRouteOptions,
): Promise<void> {
  const { paths, registryFile, workspaceRoot } = opts;
  const llm = createFakeLlm();

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

  // ──────────────────── DELETE /api/brands/:slug ────────────────────
  app.delete<{ Params: { slug: string } }>(
    '/api/brands/:slug',
    async (req, reply) => {
      const { slug } = req.params;

      // Verify brand exists before deletion
      const existing = await listBrands(registryFile);
      if (!existing.brands.some((b) => b.id === slug)) {
        return reply.code(404).send({ error: `Brand "${slug}" not found` });
      }

      await deleteBrand(paths, registryFile, slug);
      pendingSlugs.delete(slug);
      return reply.code(204).send();
    },
  );
}
