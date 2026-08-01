import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRecordingPlanUpdate, AgentRecordingSession, Storyboard } from '@vpa/shared';
import { ProjectStore } from '../project/store.js';
import { saveStoryboard, loadStoryboard } from '../storyboard/index.js';
import type { CapRuntime } from '../cap/runtime.js';
import type { CapTarget } from '../cap/types.js';
import { DesktopDriverSessionManager } from '../desktop-driver/session.js';
import type {
  DesktopDriverPlatform,
  ResolvedDesktopDriverTarget,
} from '../desktop-driver/types.js';
import type { CodexSceneRunner } from './codex-runner.js';
import { createAgentRecordingCoordinator } from './coordinator.js';
import { ingestRecording } from '../recording/ingest.js';
import type { probeVideo } from '../recording/metadata.js';
import {
  createAgentRecordingSession,
  getCurrentAgentRecordingSession,
  persistAgentRecordingIdentity,
  persistAgentRecordingStopped,
  readStoredAgentRecordingSession,
  transitionAgentRecordingSession,
  updateAgentRecordingSessionInternal,
} from './session.js';

const roots: string[] = [];
let fixtureIndex = 0;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const update: AgentRecordingPlanUpdate = {
  capture: {
    targetApplication: 'MeetingNotes',
    startingUrl: '',
    targetKind: 'window',
    width: 1920,
    height: 1080,
    fps: 30,
    cursor: true,
    microphone: false,
    camera: false,
    systemAudio: false,
  },
  steps: [
    { index: 0, action: 'Open General', checkpoint: 'General visible' },
    { index: 1, action: 'Open Model' },
  ],
  preconditions: ['Use fixtures'],
  checkpoints: ['Model visible'],
  rehearseFirst: true,
  leadInSec: 0,
  tailSec: 0,
};

const target: CapTarget = {
  kind: 'window',
  id: '42',
  name: 'Settings',
  application: 'MeetingNotes',
  width: 800,
  height: 600,
};
const rehearsedTargetIdentity = {
  cap: { kind: 'window' as const, id: '42', name: 'Settings', application: 'MeetingNotes', width: 800, height: 600 },
  desktop: { bundleId: 'MeetingNotes', displayName: 'MeetingNotes', processId: 7, windowId: 42, windowTitle: 'Settings', bounds: { x: 10, y: 20, width: 800, height: 600 } },
};

const rehearsal = {
  success: true,
  targetApplication: 'MeetingNotes',
  windowTitle: 'Settings',
  windowBounds: { x: 10, y: 20, width: 800, height: 600 },
  completedStepIndexes: [0, 1],
  checkpoints: [
    { description: 'General visible', passed: true },
    { description: 'Model visible', passed: true },
  ],
  resetConfirmed: true,
};

const execution = {
  success: true,
  completedStepIndexes: [0, 1],
  checkpoints: [
    { description: 'General visible', passed: true },
    { description: 'Model visible', passed: true },
  ],
  diagnostic: '',
};

interface FixtureOverrides {
  targets?: CapTarget[];
  cap?: Partial<CapRuntime>;
  codex?: Partial<CodexSceneRunner>;
  ingest?: typeof ingestRecording;
  probeVideo?: typeof probeVideo;
  snapshotTitle?: string;
}

async function fixture(overrides: FixtureOverrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'vpa-coordinator-home-'));
  const projects = await mkdtemp(join(tmpdir(), 'vpa-coordinator-projects-'));
  roots.push(home, projects);
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  fixtureIndex += 1;
  const project = await store.create({
    name: `project-${fixtureIndex}`,
    objective: 'Show settings',
  });
  const storyboard: Storyboard = {
    schema_version: 1,
    project: {
      id: project.id,
      name: project.name,
      created: project.created,
      objective: project.objective,
    },
    scenes: [{ id: 'scene-01', name: 'Settings', description: 'Show settings', type: 'desktop' }],
  };
  await saveStoryboard(project.path, storyboard);

  const resolved: ResolvedDesktopDriverTarget = {
    bundleId: 'MeetingNotes',
    displayName: 'MeetingNotes',
    processId: 7,
    windowId: 42,
    windowTitle: overrides.snapshotTitle ?? 'Settings',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  };
  const platform: DesktopDriverPlatform = {
    resolveWindowOwnerTarget: vi.fn(async (request) => ({
      ...resolved,
      displayName: request.displayName,
      windowId: request.windowId,
      windowTitle: request.windowTitle,
    })),
    resolveTarget: vi.fn(async (request) => ({
      ...resolved,
      bundleId: request.bundleId,
      displayName: request.displayName,
      windowId: request.windowId,
      windowTitle: request.windowTitle,
    })),
    inspect: vi.fn(async (approved) => ({
      target: { ...approved },
      windowFocused: true,
      elements: [],
    })),
    screenshot: vi.fn(async () => undefined),
    act: vi.fn(async () => undefined),
  };
  const desktop = new DesktopDriverSessionManager({ platform });

  const cap: CapRuntime = {
    getStatus: vi.fn(async () => ({
      state: 'ready' as const,
      installed: true,
      version: '1.0.0',
      cliPath: '/fake/cap',
      captureReady: true,
      missingPermissions: [],
      targetCount: 1,
      updatedAt: new Date().toISOString(),
    })),
    guide: vi.fn(async () => ({})),
    doctor: vi.fn(async () => ({ captureReady: true, missingPermissions: [] })),
    targets: vi.fn(async () => overrides.targets ?? [target]),
    startRecording: vi.fn(async () => ({
      recordingId: 'recording-exact',
      projectPath: join(project.path, 'take.cap'),
    })),
    stopRecording: vi.fn(async () => ({
      recordingMetaExists: true as const,
      projectPath: join(project.path, 'take.cap'),
    })),
    validateProject: vi.fn(async () => undefined),
    exportProject: vi.fn(async (_projectPath, outputPath) => {
      await writeFile(outputPath, 'mp4');
    }),
    ...overrides.cap,
  };
  const codex: CodexSceneRunner = {
    rehearse: vi.fn(async () => ({ threadId: 'thread-1', evidence: rehearsal })),
    resumeForRecording: vi.fn(async () => execution),
    ...overrides.codex,
  };
  const coordinator = createAgentRecordingCoordinator({
    cap,
    codex,
    desktop,
    store,
    workspaceRoot: join(project.path, 'workspace'),
    probeVideo: overrides.probeVideo ?? (async () => ({
      duration_sec: 47.2, width: 1920, height: 1080, codec: 'h264', fps: 30, size_bytes: 3,
    })),
    ingest: overrides.ingest ?? ingestRecording,
    platform: 'darwin',
    driverBaseUrl: 'http://127.0.0.1:3000',
    delay: async (_ms, signal) => {
      if (signal.aborted) throw signal.reason;
    },
  });
  return { coordinator, project, store, cap, codex, desktop, platform, resolved };
}

async function waitForSession(
  projectPath: string,
  sessionId: string,
  states: AgentRecordingSession['state'][],
): Promise<Awaited<ReturnType<typeof readStoredAgentRecordingSession>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = await readStoredAgentRecordingSession(projectPath, sessionId);
    if (states.includes(session.state)) return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Session did not reach ${states.join('/')}`);
}

async function rehearseReady(ctx: Awaited<ReturnType<typeof fixture>>) {
  const created = await ctx.coordinator.rehearse(ctx.project.id, 'scene-01', update);
  return waitForSession(ctx.project.path, created.id, ['awaiting_confirmation', 'failed']);
}

describe('agent recording coordinator', () => {
  it('schedules and verifies a successful rehearsal before confirmation', async () => {
    vi.stubEnv('VPA_TEST_SECRET', 'must-not-reach-codex');
    const ctx = await fixture();
    const created = await ctx.coordinator.rehearse(ctx.project.id, 'scene-01', update);
    expect(created.state).toBe('rehearsing');
    const ready = await waitForSession(ctx.project.path, created.id, ['awaiting_confirmation']);
    expect(ready).toMatchObject({
      state: 'awaiting_confirmation',
      planFingerprint: expect.any(String),
      codexThreadId: 'thread-1',
    });
    expect(ready.rehearsal).toEqual({
      ...rehearsal,
      checkpoints: [
        { description: 'Model visible', passed: true },
        { description: 'General visible', passed: true },
      ],
    });
    expect(ready.rehearsal).not.toHaveProperty('diagnostic');
    expect(ready.rehearsal?.checkpoints.every((checkpoint) => !('detail' in checkpoint))).toBe(true);
    expect(await getCurrentAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01')).not.toHaveProperty('rehearsedTargetIdentity');
    expect(await readStoredAgentRecordingSession(ctx.project.path, ready.id)).toHaveProperty('rehearsedTargetIdentity');
    const environment = vi.mocked(ctx.codex.rehearse).mock.calls[0]![2];
    expect(environment.VPA_DESKTOP_DRIVER_TOKEN).toBeTruthy();
    expect(environment.VPA_TEST_SECRET).toBeUndefined();
  });

  it('fails rehearsal when final independent target evidence differs', async () => {
    const ctx = await fixture({
      codex: {
        rehearse: vi.fn(async () => ({
          threadId: 'thread-1',
          evidence: { ...rehearsal, windowTitle: 'Wrong' },
        })),
      },
    });
    const created = await ctx.coordinator.rehearse(ctx.project.id, 'scene-01', update);
    const failed = await waitForSession(ctx.project.path, created.id, ['failed']);
    expect(failed.message).toBe('Codex rehearsal or final target verification failed.');
    expect((ctx.desktop as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it('publishes only allow-listed failure diagnostics without paths, tokens, or IDs', async () => {
    const ctx = await fixture();
    let capabilityToken = '';
    vi.mocked(ctx.codex.rehearse).mockImplementation(async (_prompt, _scratch, environment) => {
      capabilityToken = environment.VPA_DESKTOP_DRIVER_TOKEN ?? '';
      throw new Error(`Codex helper failed\n\tin ${ctx.project.path} token=secret ${capabilityToken} recording-exact thread-1 target 42 process 7 window 42 at 30 fps /etc/passwd ${'x'.repeat(2_000)}`);
    });
    const created = await ctx.coordinator.rehearse(ctx.project.id, 'scene-01', update);
    const failed = await waitForSession(ctx.project.path, created.id, ['failed']);
    expect(failed.message).toBe('Codex rehearsal or final target verification failed.');
    const publicSession = await getCurrentAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01');
    for (const sensitive of [ctx.project.path, 'secret', capabilityToken, 'recording-exact', 'thread-1', '/etc/passwd']) {
      expect(JSON.stringify(publicSession)).not.toContain(sensitive);
    }
    const privateSession = await readStoredAgentRecordingSession(ctx.project.path, created.id) as unknown as {
      privateDiagnostics?: Array<{ category: string; detail: string }>;
    };
    expect(privateSession.privateDiagnostics).toEqual([
      expect.objectContaining({ category: 'codex', detail: expect.stringContaining('Codex helper failed') }),
    ]);
    expect(privateSession.privateDiagnostics?.[0]?.detail.length).toBeLessThanOrEqual(1_000);
    expect(privateSession.privateDiagnostics?.[0]?.detail).not.toMatch(/[\r\n\t]/);
    expect(privateSession.privateDiagnostics?.[0]?.detail).toContain('at 30 fps');
    expect(privateSession.privateDiagnostics?.[0]?.detail).not.toMatch(/\b(?:42|7)\b/);
    for (const sensitive of [ctx.project.path, 'secret', capabilityToken, 'recording-exact', 'thread-1', '/etc/passwd']) {
      expect(JSON.stringify(privateSession.privateDiagnostics)).not.toContain(sensitive);
    }
  });

  it('rejects a non-unique target and duplicate scene work', async () => {
    const hold = deferred<ReturnType<CapRuntime['doctor']> extends Promise<infer T> ? T : never>();
    const ctx = await fixture({ cap: { doctor: vi.fn(() => hold.promise) } });
    const created = await ctx.coordinator.rehearse(ctx.project.id, 'scene-01', update);
    await expect(ctx.coordinator.rehearse(ctx.project.id, 'scene-01', update)).rejects.toThrow(
      'already active',
    );
    hold.resolve({ captureReady: true, missingPermissions: [] });
    await waitForSession(ctx.project.path, created.id, ['awaiting_confirmation']);

    const other = await fixture({
      targets: [target, { ...target, id: '43', name: 'Other settings' }],
    });
    const duplicate = await other.coordinator.rehearse(other.project.id, 'scene-01', update);
    const failed = await waitForSession(other.project.path, duplicate.id, ['failed']);
    expect(failed.message).toBe(
      'Cap or the reviewed target was not ready for rehearsal.',
    );
    expect(failed.privateDiagnostics).toEqual([
      expect.objectContaining({ category: 'cap', detail: expect.stringContaining('unique Cap window') }),
    ]);
  });

  it('rejects confirmation unless the session is awaiting confirmation', async () => {
    const ctx = await fixture();
    const session = await createAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01');
    await expect(
      ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', session.id, {
        confirmed: true,
        planFingerprint: 'x',
      }),
    ).rejects.toThrow('awaiting-confirmation');
  });

  it('fails safely when the reviewed plan changes after rehearsal', async () => {
    const ctx = await fixture();
    const ready = await rehearseReady(ctx);
    expect(ready.state).toBe('awaiting_confirmation');
    await ctx.coordinator
      .rehearse(ctx.project.id, 'scene-01', { ...update, steps: [{ index: 0, action: 'Changed' }] })
      .catch(() => undefined);
    // The active awaiting session prevents a new run, so mutate the saved plan
    // through the public plan writer by changing its JSON directly.
    const planPath = join(ctx.project.path, 'recording-plans', 'scene-01.json');
    const current = JSON.parse(await (await import('node:fs/promises')).readFile(planPath, 'utf8'));
    await writeFile(
      planPath,
      JSON.stringify({ ...current, steps: [{ index: 0, action: 'Changed' }] }),
    );
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    const failed = await waitForSession(ctx.project.path, ready.id, ['failed']);
    expect(failed.message).toBe('Confirmed recording could not start safely.');
    expect(failed.privateDiagnostics).toEqual([
      expect.objectContaining({ category: 'local', detail: expect.stringContaining('plan changed after rehearsal') }),
    ]);
    expect(ctx.cap.startRecording).not.toHaveBeenCalled();
  });

  it.each([
    ['restarted process', { processId: 8 }],
    ['reused window ID', { windowTitle: 'Different Settings' }],
    ['resized window', { bounds: { x: 10, y: 20, width: 801, height: 600 } }],
    ['substituted application', { bundleId: 'com.example.impostor' }],
  ] as const)('refuses confirmation when the rehearsed desktop target has a %s', async (_label, drift) => {
    const ctx = await fixture();
    const ready = await rehearseReady(ctx);
    vi.mocked(ctx.platform.resolveWindowOwnerTarget!).mockResolvedValueOnce({ ...ctx.resolved, ...drift });
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    const failed = await waitForSession(ctx.project.path, ready.id, ['failed']);
    expect(failed.message).toBe('Confirmed recording could not start safely.');
    expect(ctx.cap.startRecording).not.toHaveBeenCalled();
    expect(ctx.platform.resolveTarget).toHaveBeenCalledTimes(1);
  });

  it('refuses confirmation when Cap reports changed target dimensions', async () => {
    const ctx = await fixture();
    const ready = await rehearseReady(ctx);
    vi.mocked(ctx.cap.targets).mockResolvedValueOnce([{ ...target, width: 801 }]);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    expect((await waitForSession(ctx.project.path, ready.id, ['failed'])).message).toBe(
      'Confirmed recording could not start safely.',
    );
    expect(ctx.cap.startRecording).not.toHaveBeenCalled();
  });

  it('refuses confirmation when the second desktop resolution changes only window bounds', async () => {
    const ctx = await fixture();
    const ready = await rehearseReady(ctx);
    vi.mocked(ctx.platform.resolveTarget).mockResolvedValueOnce({
      ...ctx.resolved,
      bounds: { ...ctx.resolved.bounds, width: 801 },
    });
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    expect((await waitForSession(ctx.project.path, ready.id, ['failed'])).message).toBe(
      'Confirmed recording could not start safely.',
    );
    expect(ctx.cap.startRecording).not.toHaveBeenCalled();
  });

  it('persists exact start identity, stops that ID, validates, exports, and verifies ingestion', async () => {
    const ctx = await fixture();
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    await waitForSession(ctx.project.path, ready.id, ['completed']);
    const complete = await getCurrentAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-01',
    );
    expect(complete).not.toHaveProperty('recordingId');
    expect(ctx.cap.stopRecording).toHaveBeenCalledTimes(1);
    expect(ctx.cap.stopRecording).toHaveBeenCalledWith('recording-exact');
    expect(vi.mocked(ctx.cap.validateProject).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.cap.exportProject).mock.invocationCallOrder[0]!,
    );
    const storyboard = await loadStoryboard(ctx.project.path);
    expect(storyboard?.scenes[0]?.recording).toMatchObject({
      source_kind: 'cap-agent',
      capture_session_id: ready.id,
      captured_at: expect.any(String),
      source: 'recordings/scene-01.mp4',
    });
  });

  it('stops the exact recording once when Codex fails after start', async () => {
    const ctx = await fixture({
      codex: {
        resumeForRecording: vi.fn(async () => {
          throw new Error('Codex failed');
        }),
      },
    });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    expect((await waitForSession(ctx.project.path, ready.id, ['failed'])).message).toBe(
      'Codex could not complete the recorded scene.',
    );
    expect(ctx.cap.stopRecording).toHaveBeenCalledTimes(1);
    expect(ctx.cap.stopRecording).toHaveBeenCalledWith('recording-exact');
    expect(ctx.cap.validateProject).not.toHaveBeenCalled();
  });

  it('hard-stops when Cap stop metadata is unavailable', async () => {
    const ctx = await fixture({
      cap: {
        stopRecording: vi.fn(async () => {
          throw new Error('metadata missing');
        }),
      },
    });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    expect((await waitForSession(ctx.project.path, ready.id, ['failed'])).message).toBe(
      'Cap could not finalize the exact recording.',
    );
    expect(ctx.cap.stopRecording).toHaveBeenCalledTimes(1);
    expect(ctx.cap.validateProject).not.toHaveBeenCalled();
  });

  it('rejects a stopped project path that does not match the persisted start identity', async () => {
    const ctx = await fixture({
      cap: {
        stopRecording: vi.fn(async () => ({
          recordingMetaExists: true as const,
          projectPath: '/wrong/take.cap',
        })),
      },
    });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    expect((await waitForSession(ctx.project.path, ready.id, ['failed'])).message).toBe(
      'Cap could not finalize the exact recording.',
    );
    expect(ctx.cap.validateProject).not.toHaveBeenCalled();
    expect(ctx.cap.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('does not offer retry when Cap project validation fails', async () => {
    const ctx = await fixture({ cap: { validateProject: vi.fn(async () => { throw new Error('invalid project'); }) } });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    const failed = await waitForSession(ctx.project.path, ready.id, ['failed']);
    expect(failed.retryAvailable).toBeUndefined();
    expect(failed.projectValidated).toBeUndefined();
    expect(failed.message).toBe('Cap project validation failed.');
  });

  it('offers export retry only after the Cap project was durably validated', async () => {
    const ctx = await fixture({ cap: { exportProject: vi.fn(async () => { throw new Error('export failed at /private/take.cap token=export-secret recording-exact thread-1'); }) } });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    await waitForSession(ctx.project.path, ready.id, ['exporting']);
    await vi.waitFor(async () => expect((await readStoredAgentRecordingSession(ctx.project.path, ready.id)).retryAvailable).toBe('export'));
    const recoverable = await readStoredAgentRecordingSession(ctx.project.path, ready.id);
    expect(recoverable.retryAvailable).toBe('export');
    expect(recoverable.projectValidated).toBe(true);
    expect(recoverable.capProjectPath).toContain('take.cap');
    const privateDiagnostics = (recoverable as unknown as { privateDiagnostics?: Array<{ category: string; detail: string }> }).privateDiagnostics;
    expect(privateDiagnostics).toEqual([
      expect.objectContaining({ category: 'export', detail: expect.stringContaining('export failed') }),
    ]);
    expect(JSON.stringify(privateDiagnostics)).not.toMatch(/export-secret|recording-exact|thread-1|\/private\/take\.cap/);
    expect(await getCurrentAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01')).toMatchObject({
      state: 'exporting', message: 'Validated Cap project export failed. Explicit export retry is available.',
    });
    expect(await getCurrentAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01')).not.toHaveProperty('privateDiagnostics');
  });

  it('preserves the verified export when attachment fails', async () => {
    const ctx = await fixture({
      ingest: vi.fn(async () => {
        throw new Error('attach failed at /private/take.mp4 token=attach-secret recording-exact thread-1');
      }),
    });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    await waitForSession(ctx.project.path, ready.id, ['attaching']);
    await vi.waitFor(async () => expect((await readStoredAgentRecordingSession(ctx.project.path, ready.id)).retryAvailable).toBe('attachment'));
    const recoverable = await readStoredAgentRecordingSession(ctx.project.path, ready.id);
    expect(recoverable.retryAvailable).toBe('attachment');
    expect(recoverable.exportPath).toContain('take.mp4');
    const privateDiagnostics = (recoverable as unknown as { privateDiagnostics?: Array<{ category: string; detail: string }> }).privateDiagnostics;
    expect(privateDiagnostics).toEqual([
      expect.objectContaining({ category: 'attachment', detail: expect.stringContaining('attach failed') }),
    ]);
    expect(JSON.stringify(privateDiagnostics)).not.toMatch(/attach-secret|recording-exact|thread-1|\/private\/take\.mp4/);
    expect(await getCurrentAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01')).toMatchObject({
      state: 'attaching', message: 'Verified recording attachment failed. Explicit attachment retry is available.',
    });
    expect(await getCurrentAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01')).not.toHaveProperty('privateDiagnostics');
  });

  it('cancels before capture without starting a recovery recording', async () => {
    const doctor = deferred<{ captureReady: boolean; missingPermissions: [] }>();
    const ctx = await fixture({ cap: { doctor: vi.fn(() => doctor.promise) } });
    const created = await ctx.coordinator.rehearse(ctx.project.id, 'scene-01', update);
    const cancelPromise = ctx.coordinator.cancel(ctx.project.id, 'scene-01', created.id);
    doctor.resolve({ captureReady: true, missingPermissions: [] });
    const cancelled = await cancelPromise;
    expect(cancelled.state).toBe('interrupted');
    expect(ctx.cap.startRecording).not.toHaveBeenCalled();
    expect(ctx.cap.stopRecording).not.toHaveBeenCalled();
  });

  it('cancels after start and stops the exact ID once', async () => {
    const resume = deferred<typeof execution>();
    const ctx = await fixture({ codex: { resumeForRecording: vi.fn(() => resume.promise) } });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    await waitForSession(ctx.project.path, ready.id, ['recording']);
    const cancelledPromise = ctx.coordinator.cancel(ctx.project.id, 'scene-01', ready.id);
    resume.reject(new Error('aborted'));
    expect((await cancelledPromise).state).toBe('interrupted');
    expect(ctx.cap.stopRecording).toHaveBeenCalledTimes(1);
    expect(ctx.cap.stopRecording).toHaveBeenCalledWith('recording-exact');
  });

  it('persists start identity before honoring cancellation and restart cleanup never double-stops', async () => {
    const started = deferred<{ recordingId: string; projectPath: string }>();
    const ctx = await fixture({ cap: { startRecording: vi.fn(() => started.promise) } });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, {
      confirmed: true,
      planFingerprint: ready.planFingerprint!,
    });
    await vi.waitFor(() => expect(ctx.cap.startRecording).toHaveBeenCalledTimes(1));
    const cancel = ctx.coordinator.cancel(ctx.project.id, 'scene-01', ready.id);
    started.resolve({ recordingId: 'race-exact', projectPath: join(ctx.project.path, 'race.cap') });
    expect((await cancel).state).toBe('interrupted');
    expect(await readStoredAgentRecordingSession(ctx.project.path, ready.id)).toMatchObject({
      state: 'interrupted', recordingId: 'race-exact', capProjectPath: join(ctx.project.path, 'race.cap'),
      capturedAt: expect.any(String), recordingStopped: true,
    });
    expect(ctx.cap.stopRecording).toHaveBeenCalledTimes(1);
    expect(ctx.cap.stopRecording).toHaveBeenCalledWith('race-exact');
    await ctx.coordinator.reconcile();
    expect(ctx.cap.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('cancels during export probing before ingestion can mutate the storyboard', async () => {
    const probe = deferred<{ duration_sec: number; width: number; height: number; codec: string; fps: number; size_bytes: number }>();
    const ingest = vi.fn(ingestRecording);
    const probeVideo = vi.fn(() => probe.promise);
    const ctx = await fixture({ probeVideo, ingest });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, { confirmed: true, planFingerprint: ready.planFingerprint! });
    await waitForSession(ctx.project.path, ready.id, ['attaching']);
    await vi.waitFor(() => expect(probeVideo).toHaveBeenCalledTimes(1));
    const cancel = ctx.coordinator.cancel(ctx.project.id, 'scene-01', ready.id);
    probe.resolve({ duration_sec: 47.2, width: 1920, height: 1080, codec: 'h264', fps: 30, size_bytes: 3 });
    expect((await cancel).state).toBe('interrupted');
    expect(ingest).not.toHaveBeenCalled();
    expect((await loadStoryboard(ctx.project.path))?.scenes[0]?.recording).toBeUndefined();
  });

  it('lets a non-abortable ingestion commit finish truthfully when cancellation races it', async () => {
    const gate = deferred<void>();
    const ingest = vi.fn(async (...args: Parameters<typeof ingestRecording>) => {
      await gate.promise;
      return ingestRecording(...args);
    });
    const ctx = await fixture({ ingest });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, { confirmed: true, planFingerprint: ready.planFingerprint! });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    let settled = false;
    const cancel = ctx.coordinator.cancel(ctx.project.id, 'scene-01', ready.id).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    expect((await cancel).state).toBe('completed');
    expect((await loadStoryboard(ctx.project.path))?.scenes[0]?.recording).toMatchObject({ capture_session_id: ready.id });
  });

  it('recovers only the coordinator-verified export and rejects mismatched uploads', async () => {
    let failAttachment = true;
    const ingest: typeof ingestRecording = vi.fn(async (...args: Parameters<typeof ingestRecording>) => {
      if (failAttachment) throw new Error('first attachment failed');
      return ingestRecording(...args);
    });
    const ctx = await fixture({ ingest });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, { confirmed: true, planFingerprint: ready.planFingerprint! });
    await waitForSession(ctx.project.path, ready.id, ['attaching']);
    await vi.waitFor(async () => expect((await readStoredAgentRecordingSession(ctx.project.path, ready.id)).retryAvailable).toBe('attachment'));
    const stored = await readStoredAgentRecordingSession(ctx.project.path, ready.id);
    await updateAgentRecordingSessionInternal(ctx.project.path, ctx.project.id, 'scene-01', ready.id, { retryAvailable: undefined });
    await expect(ctx.coordinator.recoverAttachment(ctx.project.id, 'scene-01', ready.id, {
      capturedAt: stored.capturedAt!, uploadedPath: stored.exportPath!,
    })).rejects.toThrow('no coordinator-verified attachment recovery');
    await updateAgentRecordingSessionInternal(ctx.project.path, ctx.project.id, 'scene-01', ready.id, { retryAvailable: 'attachment' });
    const badUpload = join(ctx.project.path, 'bad-upload.mp4');
    await writeFile(badUpload, 'different');
    await expect(ctx.coordinator.recoverAttachment(ctx.project.id, 'scene-01', ready.id, {
      capturedAt: stored.capturedAt!, uploadedPath: badUpload,
    })).rejects.toThrow('recovery attachment failed');
    expect((await readStoredAgentRecordingSession(ctx.project.path, ready.id)).state).toBe('attaching');

    failAttachment = false;
    const result = await ctx.coordinator.recoverAttachment(ctx.project.id, 'scene-01', ready.id, {
      capturedAt: stored.capturedAt!, uploadedPath: stored.exportPath!,
    });
    expect(result.relativePath).toBe('recordings/scene-01.mp4');
    expect((await readStoredAgentRecordingSession(ctx.project.path, ready.id)).state).toBe('completed');
  });

  it('rejects attachment recovery while the scene coordinator is active', async () => {
    const gate = deferred<void>();
    const ingest = vi.fn(async (...args: Parameters<typeof ingestRecording>) => {
      await gate.promise;
      return ingestRecording(...args);
    });
    const ctx = await fixture({ ingest });
    const ready = await rehearseReady(ctx);
    await ctx.coordinator.confirmAndRecord(ctx.project.id, 'scene-01', ready.id, { confirmed: true, planFingerprint: ready.planFingerprint! });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    await expect(ctx.coordinator.recoverAttachment(ctx.project.id, 'scene-01', ready.id, {
      capturedAt: new Date().toISOString(), uploadedPath: join(ctx.project.path, 'anything.mp4'),
    })).rejects.toThrow('already active');
    gate.resolve();
    await waitForSession(ctx.project.path, ready.id, ['completed']);
  });

  it('reconciles active capture by exact-ID stop but leaves export and attachment recoverable', async () => {
    const ctx = await fixture();
    const recording = await createAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-01',
    );
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-01',
      recording.id,
      'awaiting_confirmation',
      { planFingerprint: 'p', rehearsal, rehearsedTargetIdentity },
    );
    await persistAgentRecordingIdentity(ctx.project.path, ctx.project.id, 'scene-01', recording.id, { recordingId: 'restart-id', projectPath: '/verified/restart.cap' }, '2026-07-31T12:00:00.000Z');
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-01',
      recording.id,
      'recording',
      {
        confirmedCapture: true,
        planFingerprint: 'p',
        stopAttempted: true,
      },
    );
    await ctx.coordinator.reconcile();
    expect((await readStoredAgentRecordingSession(ctx.project.path, recording.id)).state).toBe(
      'interrupted',
    );
    expect(ctx.cap.stopRecording).toHaveBeenCalledWith('restart-id');

    const exporting = await createAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-02',
    );
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-02',
      exporting.id,
      'awaiting_confirmation',
      { planFingerprint: 'p', rehearsal, rehearsedTargetIdentity },
    );
    await persistAgentRecordingIdentity(ctx.project.path, ctx.project.id, 'scene-02', exporting.id, { recordingId: 'already-stopped', projectPath: '/verified/take.cap' }, '2026-07-31T12:00:00.000Z');
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-02',
      exporting.id,
      'recording',
      { confirmedCapture: true, planFingerprint: 'p' },
    );
    await persistAgentRecordingStopped(ctx.project.path, ctx.project.id, 'scene-02', exporting.id, 'already-stopped', '/verified/take.cap');
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-02',
      exporting.id,
      'exporting',
      { stopAttempted: true },
    );
    await updateAgentRecordingSessionInternal(ctx.project.path, ctx.project.id, 'scene-02', exporting.id, { projectValidated: true });

    const attaching = await createAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-03',
    );
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-03',
      attaching.id,
      'awaiting_confirmation',
      { planFingerprint: 'p', rehearsal, rehearsedTargetIdentity },
    );
    await persistAgentRecordingIdentity(ctx.project.path, ctx.project.id, 'scene-03', attaching.id, { recordingId: 'already-stopped-2', projectPath: '/verified/other.cap' }, '2026-07-31T12:00:00.000Z');
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-03',
      attaching.id,
      'recording',
      { confirmedCapture: true, planFingerprint: 'p' },
    );
    await persistAgentRecordingStopped(ctx.project.path, ctx.project.id, 'scene-03', attaching.id, 'already-stopped-2', '/verified/other.cap');
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-03',
      attaching.id,
      'exporting',
      { stopAttempted: true },
    );
    await updateAgentRecordingSessionInternal(ctx.project.path, ctx.project.id, 'scene-03', attaching.id, { projectValidated: true });
    await transitionAgentRecordingSession(
      ctx.project.path,
      ctx.project.id,
      'scene-03',
      attaching.id,
      'attaching',
      { exportPath: '/verified/take.mp4', exportVerified: { sizeBytes: 3, sha256: 'a'.repeat(64) } },
    );
    await ctx.coordinator.reconcile();
    expect(await readStoredAgentRecordingSession(ctx.project.path, exporting.id)).toMatchObject({
      state: 'exporting',
      retryAvailable: 'export',
    });
    expect(await readStoredAgentRecordingSession(ctx.project.path, attaching.id)).toMatchObject({
      state: 'attaching',
      retryAvailable: 'attachment',
    });
  });

  it('privately records a sanitized terminal exact-stop reconciliation failure', async () => {
    const ctx = await fixture({
      cap: {
        stopRecording: vi.fn(async () => {
          throw new Error("Cap CLI could not stop recording 9 at file:///private/tmp/take.cap token=stop-secret");
        }),
      },
    });
    const terminal = await createAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01');
    await transitionAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01', terminal.id, 'awaiting_confirmation', {
      planFingerprint: 'p', rehearsal, rehearsedTargetIdentity,
    });
    await persistAgentRecordingIdentity(ctx.project.path, ctx.project.id, 'scene-01', terminal.id, {
      recordingId: '9', projectPath: '/private/tmp/take.cap',
    }, '2026-07-31T12:00:00.000Z');
    await transitionAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01', terminal.id, 'recording', {
      confirmedCapture: true, planFingerprint: 'p',
    });
    await transitionAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01', terminal.id, 'failed', {
      phase: 'failed', message: 'Recording workflow failed.',
    });

    await ctx.coordinator.reconcile();

    const stored = await readStoredAgentRecordingSession(ctx.project.path, terminal.id);
    expect(stored.state).toBe('failed');
    expect(stored.privateDiagnostics).toEqual([
      expect.objectContaining({ category: 'cap', detail: expect.stringContaining('Cap CLI could not stop recording') }),
    ]);
    expect(stored.privateDiagnostics?.[0]?.detail).not.toMatch(/\b9\b|stop-secret|file:\/\/\/private|private\/tmp/);
    const publicSession = await getCurrentAgentRecordingSession(ctx.project.path, ctx.project.id, 'scene-01');
    expect(publicSession).toMatchObject({ state: 'failed', message: 'Recording workflow failed.' });
    expect(publicSession).not.toHaveProperty('privateDiagnostics');
  });
});
