import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRecordingCoordinator } from './services/agent-recording/coordinator.js';
import type { AgentRecordingSession, Storyboard } from '@vpa/shared';
import type { ServerConfig } from './config.js';
import { buildServer } from './server.js';
import { saveStoryboard } from './services/storyboard/index.js';

const SESSION_ID = '64d79770-ee07-4f70-b084-2115dc28e0d3';
const NOW = '2026-07-31T12:00:00.000Z';

describe('agent recording server lifecycle', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('uses one coordinator for reconciliation and routes and keeps reconcile failure nonfatal', async () => {
    const vpaHome = await mkdtemp(join(tmpdir(), 'vpa-server-home-'));
    const projectsDefault = await mkdtemp(join(tmpdir(), 'vpa-server-projects-'));
    cleanup.push(vpaHome, projectsDefault);
    const config: ServerConfig = {
      port: 3000,
      host: '127.0.0.1',
      vpaHome,
      projectsDefault,
      webOrigin: 'http://localhost:5173',
      llm: { provider: 'fake' },
    };
    const rehearse = vi.fn(async (
      projectId: string,
      sceneId: string,
    ): Promise<AgentRecordingSession> => ({
      id: SESSION_ID,
      projectId,
      sceneId,
      state: 'rehearsing',
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const reconcile = vi.fn(async () => {
      throw new Error('persisted session could not be read');
    });
    const coordinator = {
      rehearse,
      confirmAndRecord: vi.fn(),
      cancel: vi.fn(),
      recoverAttachment: vi.fn(),
      reconcile,
    } as unknown as AgentRecordingCoordinator;

    const built = await buildServer({ config, agentRecordingCoordinator: coordinator, logger: false });
    try {
      expect(built.agentRecordingCoordinator).toBe(coordinator);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(built.capRuntime).toBeDefined();
      expect(built.capInstaller).toBeDefined();
      expect(built.desktopDriver).toBeDefined();
      expect(built.codexRunner).toBeDefined();

      const project = await built.store.create({ name: 'server-agent-demo' });
      const storyboard: Storyboard = {
        schema_version: 1,
        project: { id: project.id, name: project.name, created: project.created },
        scenes: [{
          id: 'scene-01',
          name: 'Welcome',
          description: 'Open the dashboard',
          type: 'browser',
          shot_plan: [{ index: 0, action: 'Open the dashboard' }],
        }],
      };
      await saveStoryboard(project.path, storyboard);
      const base = `/api/projects/${project.id}/scenes/scene-01/agent-recording`;
      const plan = (await built.app.inject({ method: 'GET', url: `${base}/plan` })).json();
      const update = {
        capture: { ...plan.capture, targetApplication: 'Safari' },
        steps: plan.steps,
        preconditions: plan.preconditions,
        checkpoints: ['Dashboard is visible'],
        rehearseFirst: true,
        leadInSec: 2,
        tailSec: 2,
      };
      const response = await built.app.inject({
        method: 'POST',
        url: `${base}/rehearse`,
        payload: update,
      });
      expect(response.statusCode).toBe(202);
      expect(rehearse).toHaveBeenCalledWith(project.id, 'scene-01', update);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      await built.app.close();
    }
  });
});
