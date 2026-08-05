import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Project, Storyboard } from '@vpa/shared';
import { computeWorkflowStatus } from './index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vpa-workflow-'));
  roots.push(root);
  const project: Project = {
    id: '11111111-1111-4111-8111-111111111111', name: 'demo', path: root,
    created: '2026-07-31T12:00:00.000Z', brand: null, model_routing: {},
  };
  const storyboard: Storyboard = {
    schema_version: 1,
    project: { id: project.id, name: project.name, created: project.created },
    scenes: [{ id: 'scene-1', name: 'Welcome', description: 'Open the product', type: 'browser' }],
  };
  return { root, project, storyboard };
}

describe('computeWorkflowStatus', () => {
  it('points to a missing scene recording and blocks render', async () => {
    const { root, project, storyboard } = await fixture();
    const result = await computeWorkflowStatus({ projectPath: root, project, storyboard });
    expect(result.render.ready).toBe(false);
    expect(result.nextAction).toMatchObject({ key: 'open_scene_recording', sceneId: 'scene-1' });
    expect(result.issues.some((item) => item.code === 'recording_missing')).toBe(true);
  });

  it('allows render when every recording exists and marks legacy output stale', async () => {
    const { root, project, storyboard } = await fixture();
    await mkdir(join(root, 'recordings'), { recursive: true });
    await writeFile(join(root, 'recordings', 'scene-1.mp4'), 'video');
    storyboard.scenes[0]!.recording = { source: 'recordings/scene-1.mp4' };
    let result = await computeWorkflowStatus({ projectPath: root, project, storyboard });
    expect(result.render.ready).toBe(true);
    expect(result.nextAction.key).toBe('open_render');

    await mkdir(join(root, 'renders'), { recursive: true });
    await writeFile(join(root, 'renders', 'final.mp4'), 'old video');
    result = await computeWorkflowStatus({ projectPath: root, project, storyboard });
    expect(result.render.output).toMatchObject({ state: 'stale', reason: 'Rendered before freshness tracking was added.' });
    expect(result.nextAction.key).toBe('render_again');
  });
});
