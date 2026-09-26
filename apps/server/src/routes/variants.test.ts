import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { RevisionStore } from '../services/revisions/store.js';
import { registerVariantRoutes } from './variants.js';

describe('variant routes', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-variants-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-variants-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'variants' });
    projectId = project.id;
    projectPath = project.path;
    await saveStoryboard(project.path, { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [{ id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop' }] });
    app = Fastify();
    await registerVariantRoutes(app, { store });
  });

  afterEach(async () => { await app.close(); await rm(home, { recursive: true, force: true }); await rm(projects, { recursive: true, force: true }); });

  const draft = (targetLanguage: string | null = null) => ({
    id: 'variant_portrait-001', name: 'Portrait', aspect_ratio: '9:16',
    crop: { mode: 'cover', focus_x: 0.5, focus_y: 0.5 }, safe_area: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
    selected_ranges: [], source_language: 'en', target_language: targetLanguage, captions: [], replace_narration: false, narration_replacement: null,
  });

  it('creates idempotently, reports staleness and rebases only explicitly', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/variants`, payload: draft() });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ stale: false, dimensions: { width: 1080, height: 1920 }, blockers: [] });
    const repeated = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/variants`, payload: draft() });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.json().variant.created_at).toBe(created.json().variant.created_at);

    await new RevisionStore(projectPath).execute({ expectedRevision: 0, idempotencyKey: 'variant-source-change-1', commands: [{ type: 'project.patch', patch: { objective: 'Changed' } }] });
    const stale = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/variants` })).json().variants[0];
    expect(stale).toMatchObject({ stale: true, current_revision: 1 });
    const rebased = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/variants/variant_portrait-001/rebase`, payload: { expectedUpdatedAt: stale.variant.updated_at } });
    expect(rebased.statusCode, rebased.body).toBe(200);
    expect(rebased.json()).toMatchObject({ stale: false, variant: { source_revision: 1 } });
  });

  it('blocks an unreviewed language variant without source-linked captions', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/variants`, payload: { ...draft('es'), id: 'variant_spanish-0001' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().blockers).toEqual([expect.stringMatching(/source-linked es captions/i)]);
  });
});
