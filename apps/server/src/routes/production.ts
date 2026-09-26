import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { AssetManifestSchema, ProductionRecipeSchema, type ProductionRecipeInspection } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { RevisionStore } from '../services/revisions/store.js';
import { resolveSafeProjectPath } from '../services/project/safe-path.js';
import { projectFiles } from '../services/project/paths.js';

const effects = {
  'clean-walkthrough': ['Preserve scene order and sources', 'Include narration and approved overlays', 'Render a 1080p review draft'],
  'feature-demo': ['Use screen sources only', 'Preserve original source audio', 'Render a 1080p review draft'],
  'revise-this-draft': ['Require a resolved visual-feedback revision', 'Preserve all accepted source media', 'Render the revised 1080p draft'],
} as const;

async function inspect(store: ProjectStore, projectId: string, recipe: keyof typeof effects): Promise<{ projectPath: string; inspection: ProductionRecipeInspection }> {
  const project = await store.readProject(projectId);
  const storyboard = await loadStoryboard(project.path);
  const revisions = new RevisionStore(project.path);
  const revision = await revisions.currentRevision();
  const blockers: string[] = [];
  const sources: ProductionRecipeInspection['sources'] = [];
  const assetManifest = await readFile(projectFiles(project.path).assetManifest, 'utf8').then((value) => AssetManifestSchema.parse(JSON.parse(value))).catch(() => ({ version: 1 as const, assets: [] }));
  if (!storyboard?.scenes.length) blockers.push('Create or accept a storyboard before running a production recipe.');
  for (const scene of storyboard?.scenes ?? []) {
    const clip = scene.composition?.clips[0];
    const source = scene.recording?.source;
    if (!source && !clip) { blockers.push(`${scene.name} has no source media.`); continue; }
    if (recipe === 'feature-demo' && (clip?.source_role ?? scene.recording?.source_role ?? 'screen') !== 'screen') blockers.push(`${scene.name} is not mapped to a screen source.`);
    if (source) {
      try { await stat(await resolveSafeProjectPath(project.path, source)); } catch { blockers.push(`${scene.name} source media is missing.`); }
      sources.push({ sceneId: scene.id, source, sourceRole: scene.recording?.source_role ?? 'screen' });
    } else if (clip) {
      const asset = assetManifest.assets.find((candidate) => candidate.id === clip.source_asset_id);
      if (!asset || asset.preparation.status !== 'ready') blockers.push(`${scene.name} source asset is unavailable.`);
      else {
        try { await stat(await resolveSafeProjectPath(project.path, asset.source)); } catch { blockers.push(`${scene.name} source asset file is missing.`); }
      }
      sources.push({ sceneId: scene.id, source: asset?.source ?? clip.source_asset_id, sourceRole: clip.source_role });
    }
  }
  if (recipe === 'revise-this-draft' && !(storyboard?.feedback_notes ?? []).some((note) => note.status === 'resolved')) blockers.push('Resolve at least one visual-feedback note before rendering this recipe.');
  return { projectPath: project.path, inspection: { recipe, revision, supported: blockers.length === 0, sources, blockers, effects: [...effects[recipe]] } };
}

export async function registerProductionRoutes(app: FastifyInstance, deps: { store: ProjectStore }): Promise<void> {
  app.get('/api/production/recipes', async () => ({ recipes: ProductionRecipeSchema.options.map((id) => ({ id, effects: effects[id] })) }));

  app.get('/api/projects/:id/production/recipes/:recipe/inspect', async (request, reply) => {
    const { id, recipe: raw } = request.params as { id: string; recipe: string };
    const recipe = ProductionRecipeSchema.safeParse(raw);
    if (!recipe.success) return reply.status(404).send({ error: 'Production recipe was not found.', code: 'not_found' });
    try { return (await inspect(deps.store, id, recipe.data)).inspection; } catch { return reply.status(404).send({ error: 'Project was not found.', code: 'not_found' }); }
  });

  app.post('/api/projects/:id/production/recipes/:recipe/run', async (request, reply) => {
    const { id, recipe: raw } = request.params as { id: string; recipe: string };
    const recipe = ProductionRecipeSchema.safeParse(raw);
    if (!recipe.success) return reply.status(404).send({ error: 'Production recipe was not found.', code: 'not_found' });
    let inspected: Awaited<ReturnType<typeof inspect>>;
    try {
      inspected = await inspect(deps.store, id, recipe.data);
    } catch {
      return reply.status(404).send({ error: 'Project was not found.', code: 'not_found' });
    }
    const { projectPath, inspection } = inspected;
    if (!inspection.supported) return reply.status(409).send({ error: 'The recipe cannot run with the current project sources.', code: 'recipe_blocked', inspection });
    const storyboard = (await loadStoryboard(projectPath))!;
    const revisions = new RevisionStore(projectPath);
    const result = await revisions.execute({ expectedRevision: inspection.revision, idempotencyKey: `recipe-${recipe.data}-${randomUUID()}`, targetState: 'draft', commands: storyboard.scenes.map((scene) => ({ type: 'scene.put' as const, scene })) });
    const render = await app.inject({ method: 'POST', url: `/api/projects/${encodeURIComponent(id)}/render`, payload: recipe.data === 'feature-demo' ? { includeNarration: false, includeLowerThirds: true, quality: '1080p' } : { includeNarration: true, includeLowerThirds: true, quality: '1080p' }, headers: { 'idempotency-key': `recipe-render-${randomUUID()}` } });
    const renderResult = render.json() as { jobId?: string; status?: string; error?: string; code?: string };
    if (render.statusCode >= 400) return reply.status(render.statusCode).send({ error: renderResult.error ?? 'Draft render could not start.', code: renderResult.code ?? 'render_failed', inspection });
    return reply.status(202).send({ recipe: recipe.data, revision: result.revision, inspection, ...renderResult });
  });
}
