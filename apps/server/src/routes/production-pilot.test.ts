import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../services/project/store.js';
import { projectFiles } from '../services/project/paths.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { RevisionStore } from '../services/revisions/store.js';
import { registerProductionRoutes } from './production.js';

const run = promisify(execFile);
interface PilotFixture {
  id: string;
  recipe: 'clean-walkthrough' | 'feature-demo' | 'revise-this-draft';
  role: 'screen' | 'camera';
  multiClip?: boolean;
  seedFeedback?: boolean;
}

const pilotCases: readonly PilotFixture[] = [
  { id: 'narrated', recipe: 'clean-walkthrough', role: 'screen' },
  { id: 'screen', recipe: 'feature-demo', role: 'screen' },
  { id: 'webcam', recipe: 'clean-walkthrough', role: 'camera' },
  { id: 'import', recipe: 'clean-walkthrough', role: 'screen' },
  { id: 'multiclip', recipe: 'revise-this-draft', role: 'screen', multiClip: true, seedFeedback: true },
];

describe('five-project production pilot', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let sourceTemplate: string;
  let store: ProjectStore;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-pilot-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-pilot-projects-'));
    sourceTemplate = join(home, 'pilot-source.mp4');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x2563eb:s=160x90:r=25:d=1', '-an', '-c:v', 'mpeg4', sourceTemplate]);
    store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    app = Fastify();
    app.post('/api/projects/:id/render', async (request: FastifyRequest) => {
      const { id } = request.params as { id: string };
      const project = await store.readProject(id);
      const files = projectFiles(project.path);
      const source = join(files.assetOriginalsDir, 'source.mp4');
      const output = join(project.path, 'renders', 'pilot.mp4');
      await mkdir(join(project.path, 'renders'), { recursive: true });
      await copyFile(source, output);
      return {
        jobId: randomUUID(),
        status: 'completed',
        artifacts: [{ kind: 'video', artifactId: `pilot-artifact-${project.name.replace('pilot-', '')}`, path: relative(project.path, output) }],
      };
    });
    await registerProductionRoutes(app, { store });
  });

  afterAll(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
    await rm(projects, { recursive: true, force: true });
  });

  it.each(pilotCases)('qualifies $id from Codex-callable draft through feedback, restore, and playable export', async (pilot) => {
    const project = await store.create({ name: `pilot-${pilot.id}` });
    const files = projectFiles(project.path);
    await mkdir(files.assetOriginalsDir, { recursive: true });
    const sourcePath = join(files.assetOriginalsDir, 'source.mp4');
    await copyFile(sourceTemplate, sourcePath);
    const sourceBytes = await readFile(sourcePath);
    const checksum = createHash('sha256').update(sourceBytes).digest('hex');
    const assetId = `asset_${checksum}`;
    const importedAt = '2026-09-25T21:10:00.000Z';
    await writeFile(files.assetManifest, JSON.stringify({
      version: 1,
      assets: [{ id: assetId, checksum, original_name: 'source.mp4', source: '.vpa/assets/originals/source.mp4', origin: 'source', media_kind: 'video', mime_type: 'video/mp4', size_bytes: sourceBytes.length, imported_at: importedAt, duration_sec: 1, width: 160, height: 90, timing_origin_ms: 0, source_role: pilot.role, preparation: { status: 'ready', attempts: 1, updated_at: importedAt } }],
    }));

    const clips = pilot.multiClip
      ? [
          { id: 'clip_pilot-00000001', source_asset_id: assetId, source_role: pilot.role, source_in_ms: 0, source_out_ms: 500, timeline_start_ms: 0, linked_tracks: [] },
          { id: 'clip_pilot-00000002', source_asset_id: assetId, source_role: pilot.role, source_in_ms: 500, source_out_ms: 1_000, timeline_start_ms: 500, linked_tracks: [] },
        ]
      : [{ id: 'clip_pilot-00000001', source_asset_id: assetId, source_role: pilot.role, source_in_ms: 0, source_out_ms: 1_000, timeline_start_ms: 0, linked_tracks: [] }];
    const seedNote = { id: 'note_seed-00000001', created_at: importedAt, created_revision: 0, scene_id: 'scene-01', clip_instance_id: clips[0]!.id, source_asset_id: assetId, source_in_ms: 100, source_out_ms: 300, text: 'Seed the revise recipe.', status: 'resolved' as const, resolving_revision: 0, resolution: 'Seed feedback applied.' };
    await saveStoryboard(project.path, {
      schema_version: 1,
      project: { id: project.id, name: project.name, created: project.created },
      scenes: [{
        id: 'scene-01',
        name: 'Pilot scene',
        description: `Qualify ${pilot.id}`,
        type: 'desktop',
        composition: { version: 1, clips, audio_mix: {} },
        ...(pilot.multiClip ? { visual_effects: [{ type: 'redaction' as const, id: 'effect_redact-0001', clip_instance_id: clips[1]!.id, source_asset_id: assetId, source_in_ms: 550, source_out_ms: 900, rect: { x: 0.1, y: 0.1, width: 0.25, height: 0.25 }, opacity: 1 }] } : {}),
      }],
      ...(pilot.seedFeedback ? { feedback_notes: [seedNote] } : {}),
    });

    const draft = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/production/recipes/${pilot.recipe}/run` });
    expect(draft.statusCode).toBe(202);
    expect(draft.json()).toMatchObject({ revision: 1, status: 'completed', artifacts: [{ kind: 'video', artifactId: `pilot-artifact-${pilot.id}` }] });

    const revisions = new RevisionStore(project.path);
    const feedbackId = `note_${pilot.id.padEnd(8, '0')}`;
    await revisions.execute({ expectedRevision: 1, idempotencyKey: `pilot-feedback-${pilot.id}`, commands: [{ type: 'feedback.add', note: { id: feedbackId, created_at: importedAt, created_revision: 1, scene_id: 'scene-01', clip_instance_id: clips[0]!.id, source_asset_id: assetId, source_in_ms: 300, source_out_ms: 450, text: 'Tighten this moment.', status: 'pending' } }] });
    await revisions.execute({ expectedRevision: 2, idempotencyKey: `pilot-resolve-${pilot.id}`, commands: [
      { type: 'feedback.claim', noteId: feedbackId, actor: 'codex-pilot', claimedAt: importedAt },
      { type: 'feedback.resolve', noteId: feedbackId, resolvingRevision: 3, resolution: 'Applied the bounded pilot revision.' },
    ] });
    await revisions.execute({ expectedRevision: 3, idempotencyKey: `pilot-restore-${pilot.id}`, commands: [{ type: 'revision.restore', revision: 1 }] });

    const restored = await loadStoryboard(project.path);
    expect(restored?.scenes[0]?.composition?.clips).toEqual(clips);
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(checksum);
    const artifact = join(project.path, draft.json().artifacts[0].path as string);
    expect((await stat(artifact)).size).toBeGreaterThan(0);
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration', '-of', 'json', artifact])).stdout);
    expect(probe.streams).toContainEqual(expect.objectContaining({ codec_type: 'video' }));
    expect(Number(probe.format.duration)).toBeGreaterThan(0);
    expect(await revisions.currentRevision()).toBe(4);
  });
});
