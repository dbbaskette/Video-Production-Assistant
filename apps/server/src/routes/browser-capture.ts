import type { FastifyInstance } from 'fastify';
import { BrowserCaptureCreateSchema } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { BrowserCaptureError, BrowserCaptureStore } from '../services/browser-capture/store.js';
import { loadStoryboard } from '../services/storyboard/index.js';

const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

function statusFor(error: BrowserCaptureError): number {
  if (error.code === 'not_found') return 404;
  if (error.code === 'chunk_conflict' || error.code === 'invalid_state') return 409;
  return 400;
}

export async function registerBrowserCaptureRoutes(app: FastifyInstance, deps: {
  store: ProjectStore;
  createCaptureStore?: (root: string) => BrowserCaptureStore;
}): Promise<void> {
  const createCaptureStore = deps.createCaptureStore ?? ((root: string) => new BrowserCaptureStore(root));
  const resolve = async (projectId: string): Promise<string | null> =>
    (await deps.store.readTracker()).projects.find((project) => project.id === projectId)?.path ?? null;

  app.get('/api/projects/:id/browser-captures', async (request, reply) => {
    const { id } = request.params as { id: string };
    const root = await resolve(id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    return { sessions: await createCaptureStore(root).list() };
  });

  app.post('/api/projects/:id/browser-captures', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = BrowserCaptureCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Capture settings are invalid.', code: 'invalid_request' });
    const root = await resolve(id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    const storyboard = await loadStoryboard(root);
    if (!storyboard?.scenes.some((scene) => scene.id === parsed.data.sceneId)) {
      return reply.status(404).send({ error: 'Scene not found.', code: 'not_found' });
    }
    return reply.status(201).send({ session: await createCaptureStore(root).create(id, parsed.data) });
  });

  app.post('/api/projects/:id/browser-captures/:sessionId/tracks/:trackId/chunks/:sequence', async (request, reply) => {
    const { id, sessionId, trackId, sequence: rawSequence } = request.params as { id: string; sessionId: string; trackId: string; sequence: string };
    const sequence = Number(rawSequence);
    const root = await resolve(id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    try {
      const part = await request.file({ limits: { files: 1, fileSize: MAX_CHUNK_BYTES } });
      if (!part) return reply.status(400).send({ error: 'Capture chunk is required.', code: 'invalid_chunk' });
      const bytes = await part.toBuffer();
      const ack = await createCaptureStore(root).appendChunk(sessionId, trackId, sequence, bytes);
      return { acknowledgement: ack };
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.status(413).send({ error: 'Capture chunk exceeds 16 MiB.', code: 'invalid_chunk' });
      }
      if (error instanceof BrowserCaptureError) return reply.status(statusFor(error)).send({ error: error.message, code: error.code, retryable: error.retryable });
      throw error;
    }
  });

  app.post('/api/projects/:id/browser-captures/:sessionId/incomplete', async (request, reply) => {
    const { id, sessionId } = request.params as { id: string; sessionId: string };
    const root = await resolve(id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    try {
      return { session: await createCaptureStore(root).markIncomplete(sessionId) };
    } catch (error) {
      if (error instanceof BrowserCaptureError) return reply.status(statusFor(error)).send({ error: error.message, code: error.code });
      throw error;
    }
  });

  app.post('/api/projects/:id/browser-captures/:sessionId/complete', async (request, reply) => {
    const { id, sessionId } = request.params as { id: string; sessionId: string };
    const root = await resolve(id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    try {
      return { session: await createCaptureStore(root).complete(sessionId) };
    } catch (error) {
      if (error instanceof BrowserCaptureError) return reply.status(statusFor(error)).send({ error: error.message, code: error.code, retryable: error.retryable });
      throw error;
    }
  });
}
