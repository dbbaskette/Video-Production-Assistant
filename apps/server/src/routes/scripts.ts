import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../services/storyboard/index.js';
import { generateScript } from '../services/script/index.js';

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  workspaceRoot: string;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerScriptRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, llm, workspaceRoot } = deps;

  // GET /api/projects/:id/scenes/:sceneId/script — get current script
  app.get('/api/projects/:id/scenes/:sceneId/script', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    return {
      sceneId,
      script: scene.narration?.script ?? null,
      hasRecording: !!scene.recording,
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/script/generate — generate script via LLM
  app.post('/api/projects/:id/scenes/:sceneId/script/generate', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const script = await generateScript(
      {
        sceneName: scene.name,
        sceneDescription: scene.description,
        sceneType: scene.type,
        durationSec: scene.recording?.duration_sec,
        projectObjective: sb.project.objective,
        projectAudience: sb.project.audience,
        projectPath,
      },
      llm,
      workspaceRoot,
    );

    // Save script to storyboard under narration.script AND monologueScript
    const narration = { ...(scene.narration ?? {}), script, monologueScript: script };
    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    return { sceneId, script };
  });

  // PUT /api/projects/:id/scenes/:sceneId/script — save edited script
  app.put('/api/projects/:id/scenes/:sceneId/script', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { script } = req.body as { script?: string };

    if (typeof script !== 'string') {
      return reply.status(400).send({ error: 'script is required', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const narration = { ...(scene.narration ?? {}), script, monologueScript: script };
    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    return { sceneId, script };
  });
}
