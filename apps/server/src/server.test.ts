import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRecordingCoordinator } from './services/agent-recording/coordinator.js';
import type { AgentRecordingSession, PresentationJob, Storyboard } from '@vpa/shared';
import type { ServerConfig } from './config.js';
import { buildServer } from './server.js';
import { saveStoryboard } from './services/storyboard/index.js';
import { PresentationImportService } from './services/presentation/import-service.js';
import { PresentationNarrationDrafter } from './services/presentation/narration-drafter.js';

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
      presentation: { maxBytes: 100 * 1024 * 1024, maxPages: 200 },
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
    const reconcile = vi.fn<
      Parameters<PresentationImportService['reconcile']>,
      ReturnType<PresentationImportService['reconcile']>
    >(async () => {
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
      expect(built.presentationService).toBeInstanceOf(PresentationImportService);
      expect(built.presentationNarrationDrafter).toBeInstanceOf(PresentationNarrationDrafter);

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

  it('registers presentation routes with an injected service and reconciles without import work', async () => {
    const vpaHome = await mkdtemp(join(tmpdir(), 'vpa-server-presentation-home-'));
    const projectsDefault = await mkdtemp(join(tmpdir(), 'vpa-server-presentation-projects-'));
    cleanup.push(vpaHome, projectsDefault);
    const config: ServerConfig = {
      port: 3000,
      host: '127.0.0.1',
      vpaHome,
      projectsDefault,
      webOrigin: 'http://localhost:5173',
      llm: { provider: 'fake' },
      presentation: { maxBytes: 64, maxPages: 12 },
    };
    const reconcile = vi.fn<
      Parameters<PresentationImportService['reconcile']>,
      ReturnType<PresentationImportService['reconcile']>
    >(async () => undefined);
    const list = vi.fn(async (): Promise<PresentationJob[]> => []);
    const presentationService = {
      reconcile,
      list,
      get: vi.fn(),
      registerUpload: vi.fn(),
      process: vi.fn(),
      retryImport: vi.fn(),
      remove: vi.fn(),
    } as unknown as PresentationImportService;
    const presentationNarrationDrafter = {
      run: vi.fn(async () => { throw new Error('not used'); }),
      retry: vi.fn(async () => undefined as never),
    } as unknown as PresentationNarrationDrafter;
    const agentRecordingCoordinator = {
      rehearse: vi.fn(),
      confirmAndRecord: vi.fn(),
      cancel: vi.fn(),
      recoverAttachment: vi.fn(),
      reconcile: vi.fn(async () => undefined),
    } as unknown as AgentRecordingCoordinator;

    const built = await buildServer({
      config,
      presentationService,
      presentationNarrationDrafter,
      agentRecordingCoordinator,
      logger: false,
    });
    try {
      expect(built.presentationService).toBe(presentationService);
      expect(built.presentationNarrationDrafter).toBe(presentationNarrationDrafter);
      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith([], expect.any(Function));
      const retry = reconcile.mock.calls[0]![1]!;
      const retryProject = { id: '11111111-1111-4111-8111-111111111111' } as never;
      const retryPresentationId = '22222222-2222-4222-8222-222222222222';
      await retry(retryProject, retryPresentationId);
      expect(presentationNarrationDrafter.retry).toHaveBeenCalledWith(
        retryProject,
        retryPresentationId,
      );

      const project = await built.store.create({ name: 'presentation-route-server-test' });
      const response = await built.app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/presentations`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ presentations: [] });
      expect(list).toHaveBeenCalledWith(project.path);
    } finally {
      await built.app.close();
    }
  });
});
