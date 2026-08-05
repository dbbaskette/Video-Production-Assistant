import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  PresentationJobSchema,
  PresentationManifestSchema,
  type PresentationJob,
  type Project,
} from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { projectFiles } from '../services/project/paths.js';
import {
  PresentationImportError,
  type PresentationImportService,
} from '../services/presentation/import-service.js';
import {
  stageUploadStream,
  StagedUploadError,
} from '../services/recording/staged-upload.js';

const ABSOLUTE_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PRESENTATION_PAGES = 200;
const UuidSchema = z.string().uuid();
const PageNumberSchema = z.coerce.number().int().min(1).max(MAX_PRESENTATION_PAGES);

export interface PresentationRouteDeps {
  store: ProjectStore;
  service: PresentationImportService;
  maxBytes: number;
  retryNarration?: (project: Project, presentationId: string) => Promise<PresentationJob>;
  openFile?: typeof open;
}

class PresentationRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PresentationRouteError';
  }
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : 'UnknownError';
}

function requireUuid(value: string, code: string, label: string): string {
  if (!UuidSchema.safeParse(value).success) {
    throw new PresentationRouteError(400, code, `Invalid ${label}`);
  }
  return value;
}

function requirePageNumber(value: string): number {
  const parsed = PageNumberSchema.safeParse(value);
  if (!parsed.success || String(parsed.data) !== value) {
    throw new PresentationRouteError(400, 'invalid_page_number', 'Invalid presentation page number');
  }
  return parsed.data;
}

async function requireProject(store: ProjectStore, id: string): Promise<Project> {
  requireUuid(id, 'invalid_project_id', 'project id');
  try {
    return await store.readProject(id);
  } catch {
    throw new PresentationRouteError(404, 'not_found', 'Project not found');
  }
}

function requireJob(value: unknown, project: Project, presentationId?: string): PresentationJob {
  const parsed = PresentationJobSchema.safeParse(value);
  if (!parsed.success
    || parsed.data.project_id !== project.id
    || (presentationId !== undefined && parsed.data.id !== presentationId)) {
    throw new PresentationRouteError(500, 'presentation_failed', 'Presentation request failed');
  }
  return parsed.data;
}

function sendRouteError(reply: FastifyReply, error: unknown) {
  if (error instanceof PresentationRouteError) {
    return reply.status(error.statusCode).send({ error: error.message, code: error.code });
  }
  if (error instanceof PresentationImportError) {
    if (error.code === 'source_not_available' || error.code === 'invalid_import_state') {
      return reply.status(409).send({ error: error.message, code: error.code });
    }
    if (error.code === 'invalid_source') {
      return reply.status(400).send({ error: 'Invalid presentation source', code: error.code });
    }
    return reply.status(500).send({ error: 'Presentation request failed', code: 'presentation_failed' });
  }
  return reply.status(500).send({ error: 'Presentation request failed', code: 'presentation_failed' });
}

async function drain(source: AsyncIterable<Buffer | Uint8Array>): Promise<void> {
  for await (const chunk of source) {
    // Multipart streams must be consumed before the request can complete.
    void chunk;
  }
}

async function parseUpload(
  request: FastifyRequest,
  destination: string,
  maxBytes: number,
): Promise<{ filename: string; sizeBytes: number; generateNarration: boolean }> {
  let fileCount = 0;
  let filename = 'Presentation.pdf';
  let sizeBytes = 0;
  let narrationValue: string | undefined;
  let invalid = false;
  const parts = request.parts({
    limits: { fileSize: maxBytes, files: 2, fields: 4, parts: 6 },
  });

  for await (const part of parts) {
    if (part.type === 'file') {
      fileCount += 1;
      if (fileCount === 1 && part.fieldname === 'file') {
        filename = part.filename || filename;
        const staged = await stageUploadStream(destination, part.file, maxBytes);
        sizeBytes = staged.sizeBytes;
        if (part.file.truncated) {
          throw new StagedUploadError('file_too_large', 'Uploaded file exceeds the byte limit.');
        }
      } else {
        invalid = true;
        await drain(part.file);
      }
      continue;
    }

    if (part.fieldname !== 'generate_narration'
      || narrationValue !== undefined
      || typeof part.value !== 'string') {
      invalid = true;
      continue;
    }
    narrationValue = part.value;
  }

  if (fileCount !== 1 || sizeBytes < 1 || invalid) {
    throw new PresentationRouteError(400, 'invalid_upload', 'Upload one non-empty PDF file');
  }
  if (narrationValue !== undefined && narrationValue !== 'true' && narrationValue !== 'false') {
    throw new PresentationRouteError(400, 'invalid_upload', 'generate_narration must be true or false');
  }
  return {
    filename,
    sizeBytes,
    generateNarration: narrationValue === undefined ? true : narrationValue === 'true',
  };
}

async function servePageImage(
  reply: FastifyReply,
  project: Project,
  presentationId: string,
  pageNumber: number,
  openFile: typeof open,
) {
  const bundle = path.join(projectFiles(project.path).presentationsDir, presentationId);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const manifest = PresentationManifestSchema.parse(
      JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8')),
    );
    if (manifest.id !== presentationId || manifest.project_id !== project.id) throw new Error('mismatch');
    const page = manifest.pages.find((candidate) => candidate.page_number === pageNumber);
    if (!page) throw new Error('missing page');

    const bundleRelative = `presentations/${presentationId}/`;
    const expectedImage = `${bundleRelative}pages/page-${String(pageNumber).padStart(4, '0')}.png`;
    if (page.image !== expectedImage
      || !page.image.startsWith(bundleRelative)
      || path.isAbsolute(page.image)
      || page.image.includes('\\')) {
      throw new Error('unsafe image');
    }
    const imagePath = path.resolve(project.path, page.image);
    const resolvedBundle = path.resolve(bundle);
    if (!imagePath.startsWith(`${resolvedBundle}${path.sep}`)) throw new Error('outside bundle');
    const imageInfo = await lstat(imagePath);
    if (!imageInfo.isFile() || imageInfo.isSymbolicLink()) throw new Error('missing image');
    const [realProjectRoot, realBundle, realImage] = await Promise.all([
      realpath(project.path),
      realpath(bundle),
      realpath(imagePath),
    ]);
    const expectedRealBundle = path.join(realProjectRoot, 'presentations', presentationId);
    if (realBundle !== expectedRealBundle || !realImage.startsWith(`${realBundle}${path.sep}`)) {
      throw new Error('symlinked image');
    }
    handle = await openFile(realImage, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.dev !== imageInfo.dev || openedInfo.ino !== imageInfo.ino) {
      throw new Error('image changed before open');
    }

    reply.header('Content-Type', 'image/png');
    reply.header('X-Content-Type-Options', 'nosniff');
    const stream = handle.createReadStream({ autoClose: true, start: 0 });
    handle = undefined;
    return reply.send(stream);
  } catch {
    await handle?.close().catch(() => undefined);
    throw new PresentationRouteError(404, 'not_found', 'Presentation page image not found');
  }
}

export async function registerPresentationRoutes(
  app: FastifyInstance,
  deps: PresentationRouteDeps,
): Promise<void> {
  if (!Number.isSafeInteger(deps.maxBytes) || deps.maxBytes <= 0) {
    throw new Error('Presentation upload byte limit must be a positive safe integer');
  }
  const maxBytes = Math.min(deps.maxBytes, ABSOLUTE_MAX_UPLOAD_BYTES);
  const openFile = deps.openFile ?? open;

  app.post('/api/projects/:id/presentations', async (request, reply) => {
    let stagingRoot: string | undefined;
    let registered = false;
    try {
      const { id: projectId } = request.params as { id: string };
      const project = await requireProject(deps.store, projectId);
      const presentationId = randomUUID();
      stagingRoot = path.join(projectFiles(project.path).presentationStagingDir, presentationId);
      const source = path.join(stagingRoot, 'source.pdf');
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const upload = await parseUpload(request, source, maxBytes);
      const job = requireJob(await deps.service.registerUpload({
        project,
        id: presentationId,
        filename: upload.filename,
        stagedSourcePath: source,
        sizeBytes: upload.sizeBytes,
        generateNarration: upload.generateNarration,
      }), project, presentationId);
      registered = true;
      void deps.service.process(project, presentationId).catch((error: unknown) => {
        app.log.warn({
          projectId: project.id,
          presentationId,
          errorName: safeErrorName(error),
        }, 'Detached presentation processing failed');
      });
      return reply.status(202).send({ presentation_id: presentationId, job });
    } catch (error) {
      if (!registered && stagingRoot) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        await rmdir(path.dirname(stagingRoot)).catch(() => undefined);
      }
      if (error instanceof StagedUploadError
        || error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.status(413).send({
          error: 'The presentation exceeds the upload size limit',
          code: 'file_too_large',
        });
      }
      if (error instanceof app.multipartErrors.FilesLimitError
        || error instanceof app.multipartErrors.FieldsLimitError
        || error instanceof app.multipartErrors.PartsLimitError
        || error instanceof app.multipartErrors.InvalidMultipartContentTypeError) {
        return reply.status(400).send({ error: 'Upload one non-empty PDF file', code: 'invalid_upload' });
      }
      return sendRouteError(reply, error);
    }
  });

  app.get('/api/projects/:id/presentations', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const project = await requireProject(deps.store, id);
      const jobs = (await deps.service.list(project.path)).map((value) => requireJob(value, project));
      return { presentations: jobs };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get('/api/projects/:id/presentations/:presentationId', async (request, reply) => {
    try {
      const { id, presentationId: rawPresentationId } = request.params as {
        id: string;
        presentationId: string;
      };
      const project = await requireProject(deps.store, id);
      const presentationId = requireUuid(rawPresentationId, 'invalid_presentation_id', 'presentation id');
      const value = await deps.service.get(project.path, presentationId);
      if (!value) throw new PresentationRouteError(404, 'not_found', 'Presentation not found');
      return requireJob(value, project, presentationId);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post('/api/projects/:id/presentations/:presentationId/retry-import', async (request, reply) => {
    try {
      const { id, presentationId: rawPresentationId } = request.params as {
        id: string;
        presentationId: string;
      };
      const project = await requireProject(deps.store, id);
      const presentationId = requireUuid(rawPresentationId, 'invalid_presentation_id', 'presentation id');
      return requireJob(await deps.service.retryImport(project, presentationId), project, presentationId);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post('/api/projects/:id/presentations/:presentationId/retry-narration', async (request, reply) => {
    try {
      const { id, presentationId: rawPresentationId } = request.params as {
        id: string;
        presentationId: string;
      };
      const project = await requireProject(deps.store, id);
      const presentationId = requireUuid(rawPresentationId, 'invalid_presentation_id', 'presentation id');
      const value = await deps.service.get(project.path, presentationId);
      if (!value) throw new PresentationRouteError(404, 'not_found', 'Presentation not found');
      requireJob(value, project, presentationId);
      if (!deps.retryNarration) {
        return reply.status(501).send({
          error: 'Presentation narration is not available',
          code: 'narration_not_implemented',
        });
      }
      return requireJob(
        await deps.service.retryNarration(project, presentationId, deps.retryNarration),
        project,
        presentationId,
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete('/api/projects/:id/presentations/:presentationId', async (request, reply) => {
    try {
      const { id, presentationId: rawPresentationId } = request.params as {
        id: string;
        presentationId: string;
      };
      const project = await requireProject(deps.store, id);
      const presentationId = requireUuid(rawPresentationId, 'invalid_presentation_id', 'presentation id');
      const query = request.query as { confirmed?: string };
      if (query.confirmed !== 'true') {
        throw new PresentationRouteError(400, 'confirmation_required', 'Deletion requires confirmed=true');
      }
      const value = await deps.service.get(project.path, presentationId);
      if (!value) {
        throw new PresentationRouteError(404, 'not_found', 'Presentation not found');
      }
      requireJob(value, project, presentationId);
      await deps.service.remove(project, presentationId);
      return reply.status(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get('/api/projects/:id/presentations/:presentationId/pages/:pageNumber/image', async (request, reply) => {
    try {
      const { id, presentationId: rawPresentationId, pageNumber: rawPageNumber } = request.params as {
        id: string;
        presentationId: string;
        pageNumber: string;
      };
      const project = await requireProject(deps.store, id);
      const presentationId = requireUuid(rawPresentationId, 'invalid_presentation_id', 'presentation id');
      const pageNumber = requirePageNumber(rawPageNumber);
      return await servePageImage(reply, project, presentationId, pageNumber, openFile);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
