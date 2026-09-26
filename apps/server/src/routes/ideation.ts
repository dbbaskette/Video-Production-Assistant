import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import { ModelRoutingError, type ModelRouter } from '../services/llm/model-router.js';
import { IdeationManager, IdeationSession, type IdeationState } from '../services/ideation/index.js';
import { createStoryboard, saveStoryboard } from '../services/storyboard/index.js';
import { sourceDocsNeedSummarization } from '../services/project-source-docs/context.js';
import { ProposalOperationSchema } from '@vpa/shared';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from '../lib/fs-atomic.js';
import { projectFiles } from '../services/project/paths.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { RevisionStore } from '../services/revisions/store.js';

interface Deps {
  store: ProjectStore;
  router: ModelRouter;
  ideationManager: IdeationManager;
}

async function resolveProject(store: ProjectStore, projectId: string) {
  try {
    return await store.readProject(projectId);
  } catch {
    throw { statusCode: 404, message: `Project not found: ${projectId}` };
  }
}

export async function registerIdeationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, router, ideationManager } = deps;
  const sessionFor = async (id: string, projectPath: string) => {
    const existing = ideationManager.get(id);
    if (existing) return existing;
    let initial: Partial<IdeationState> | undefined;
    try { initial = JSON.parse(await readFile(projectFiles(projectPath).ideation, 'utf8')) as Partial<IdeationState>; } catch { initial = undefined; }
    return ideationManager.getOrCreate(id, initial);
  };
  const persistSession = async (projectPath: string, session: ReturnType<IdeationManager['getOrCreate']>) => {
    await atomicWriteFile(projectFiles(projectPath).ideation, JSON.stringify(session.getState(), null, 2));
  };

  // GET /api/projects/:id/ideation — get current session state
  app.get('/api/projects/:id/ideation', async (req) => {
    const { id } = req.params as { id: string };
    const project = await resolveProject(store, id);
    const session = await sessionFor(id, project.path);
    return session.getState();
  });

  // POST /api/projects/:id/ideation/message — send a user message
  app.post('/api/projects/:id/ideation/message', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await resolveProject(store, id);
    const { content } = req.body as { content?: string };

    if (!content || typeof content !== 'string' || !content.trim()) {
      return reply.status(400).send({ error: 'content is required', code: 'invalid_request' });
    }

    try {
      const needsGeneral = await sourceDocsNeedSummarization(project.path);
      const writer = await router.resolveText('writing', project);
      const general = needsGeneral
        ? await router.resolveText('general', project)
        : undefined;
      const session = await sessionFor(id, project.path);
      const candidate = new IdeationSession(id, session.getState());
      const message = await candidate.sendMessage(
        content.trim(),
        writer.client,
        project.objective,
        project.path,
        general?.client,
      );
      await persistSession(project.path, candidate);
      ideationManager.set(candidate);
      return message;
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      req.log.error({ projectId: id, errorName: 'IdeationError' }, 'Ideation failed');
      return reply.status(502).send({
        error: 'Ideation failed. Your existing ideas were not changed.',
        code: 'ideation_failed',
      });
    }
  });

  app.patch('/api/projects/:id/ideation/proposal', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProposalOperationSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Proposal edit is invalid.', code: 'invalid_request', details: parsed.error.flatten() });
    const project = await resolveProject(store, id);
    const session = await sessionFor(id, project.path);
    try {
      const candidate = new IdeationSession(id, session.getState());
      candidate.applyProposalOperation(parsed.data);
      await persistSession(project.path, candidate);
      ideationManager.set(candidate);
      return candidate.getState();
    } catch (error) {
      return reply.status(409).send({ error: error instanceof Error ? error.message : 'Proposal edit failed.', code: 'proposal_conflict' });
    }
  });

  app.get('/api/projects/:id/ideation/accept-preview', async (req) => {
    const { id } = req.params as { id: string };
    const project = await resolveProject(store, id);
    const session = await sessionFor(id, project.path);
    const current = await loadStoryboard(project.path);
    const proposedIds = new Set(session.proposedScenes.map((scene) => scene.id));
    const preserved = (current?.scenes ?? []).filter((scene) => !proposedIds.has(scene.id) && (!!scene.recording || (scene.composition?.clips.length ?? 0) > 0));
    const removed = (current?.scenes ?? []).filter((scene) => !proposedIds.has(scene.id) && !preserved.includes(scene));
    return { mode: current ? 'replace' : 'create', proposed: session.proposedScenes.length, preserved: preserved.map((scene) => scene.id), removed: removed.map((scene) => scene.id) };
  });

  // POST /api/projects/:id/ideation/accept — accept proposed scenes, write storyboard.yaml
  app.post('/api/projects/:id/ideation/accept', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await resolveProject(store, id);

    if (!ideationManager.get(id)) {
      try { await readFile(projectFiles(project.path).ideation, 'utf8'); } catch { return reply.status(400).send({ error: 'No ideation session found', code: 'no_session' }); }
    }
    const session = await sessionFor(id, project.path);

    const { proposedScenes } = session.getState();
    if (proposedScenes.length === 0) {
      return reply.status(400).send({ error: 'No scenes to accept', code: 'no_scenes' });
    }

    const current = await loadStoryboard(project.path);
    if (!current) {
      const storyboard = createStoryboard(project, proposedScenes);
      await saveStoryboard(project.path, storyboard);
      await new RevisionStore(project.path).currentRevision();
      return { ...storyboard, acceptance: { mode: 'create', preserved: [], removed: [], revision: 0 } };
    }
    const proposedIds = new Set(proposedScenes.map((scene) => scene.id));
    const existingById = new Map(current.scenes.map((scene) => [scene.id, scene]));
    const merged = proposedScenes.map((scene) => ({ ...(existingById.get(scene.id) ?? {}), ...scene }));
    const preserved = current.scenes.filter((scene) => !proposedIds.has(scene.id) && (!!scene.recording || (scene.composition?.clips.length ?? 0) > 0));
    const removed = current.scenes.filter((scene) => !proposedIds.has(scene.id) && !preserved.includes(scene));
    const finalScenes = [...merged, ...preserved];
    const revisions = new RevisionStore(project.path);
    const revision = await revisions.currentRevision();
    const commands = [
      ...current.scenes.filter((scene) => !finalScenes.some((next) => next.id === scene.id)).map((scene) => ({ type: 'scene.delete' as const, sceneId: scene.id })),
      ...finalScenes.map((scene) => existingById.has(scene.id) ? ({ type: 'scene.put' as const, scene }) : ({ type: 'scene.add' as const, scene })),
      { type: 'scene.reorder' as const, sceneIds: finalScenes.map((scene) => scene.id) },
    ];
    const result = await revisions.execute({ expectedRevision: revision, idempotencyKey: `proposal-accept-${randomUUID()}`, targetState: 'accepted', commands });
    const storyboard = await loadStoryboard(project.path);
    return { ...storyboard!, acceptance: { mode: 'replace', preserved: preserved.map((scene) => scene.id), removed: removed.map((scene) => scene.id), revision: result.revision } };
  });
}
