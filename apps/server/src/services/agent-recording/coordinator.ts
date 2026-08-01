import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentRecordingConfirmRequestSchema,
  AgentRecordingPlanUpdateSchema,
  AgentRecordingSessionSchema,
  type AgentRecordingConfirmRequest,
  type AgentRecordingPlan,
  type AgentRecordingPlanUpdate,
  type AgentRecordingSession,
  type Scene,
} from '@vpa/shared';
import type { ProjectStore } from '../project/store.js';
import { loadStoryboard } from '../storyboard/index.js';
import { probeVideo as probe, type VideoMetadata } from '../recording/metadata.js';
import { ingestRecording, type IngestResult } from '../recording/ingest.js';
import type { CapRuntime } from '../cap/runtime.js';
import type { CapTarget } from '../cap/types.js';
import { DESKTOP_DRIVER_ENV, type DesktopDriverCapability } from '../desktop-driver/types.js';
import type { DesktopDriverSessionManager } from '../desktop-driver/session.js';
import type { CodexSceneRunner } from './codex-runner.js';
import { readAgentRecordingPlan, saveAgentRecordingPlan } from './plan.js';
import {
  createAgentRecordingSession,
  getCurrentAgentRecordingSession,
  listStoredAgentRecordingSessions,
  persistAgentRecordingIdentity,
  persistAgentRecordingStopped,
  readStoredAgentRecordingSession,
  transitionAgentRecordingSession,
  updateAgentRecordingSessionInternal,
} from './session.js';

const ALL_DRIVER_OPERATIONS = [
  'inspect',
  'screenshot',
  'click',
  'set-value',
  'type-text',
  'press-key',
] as const;

type SessionInternal = Awaited<ReturnType<typeof readStoredAgentRecordingSession>>;

interface ActiveRun {
  sessionId: string;
  projectId: string;
  sceneId: string;
  projectPath: string;
  controller: AbortController;
  promise: Promise<void>;
  recordingId?: string;
  stopAttempted: boolean;
  driverSessionId?: string;
}

interface SessionContext {
  target: CapTarget;
  driver: DesktopDriverCapability;
}

export interface AgentRecordingCoordinatorDeps {
  cap: CapRuntime;
  codex: CodexSceneRunner;
  desktop: DesktopDriverSessionManager;
  store: ProjectStore;
  workspaceRoot: string;
  probeVideo: typeof probe;
  ingest: typeof ingestRecording;
  now?: () => Date;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable only so automated tests do not depend on their host OS. */
  platform?: NodeJS.Platform;
  /** Loopback origin used by the fixed helper; never accepted from a route. */
  driverBaseUrl?: string;
}

export interface AgentRecordingCoordinator {
  rehearse(
    projectId: string,
    sceneId: string,
    update: AgentRecordingPlanUpdate,
  ): Promise<AgentRecordingSession>;
  confirmAndRecord(
    projectId: string,
    sceneId: string,
    sessionId: string,
    input: AgentRecordingConfirmRequest,
  ): Promise<AgentRecordingSession>;
  cancel(projectId: string, sceneId: string, sessionId: string): Promise<AgentRecordingSession>;
  reconcile(): Promise<void>;
}

function planFingerprint(plan: AgentRecordingPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function sceneKey(projectId: string, sceneId: string): string {
  return `${projectId}\u0000${sceneId}`;
}

function normalized(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function errorMessage(error: unknown, privateValues: Array<string | undefined> = []): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = privateValues
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((value, privateValue) => value.replaceAll(privateValue, '[local path]'), message);
  return (
    Buffer.from(redacted).subarray(0, 2_000).toString('utf8') || 'Recording coordination failed.'
  );
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Recording was cancelled.'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error('Recording was cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function exactStepIndexes(plan: AgentRecordingPlan, actual: number[]): boolean {
  const expected = [...new Set(plan.steps.map((step) => step.index))].sort((a, b) => a - b);
  const completed = [...new Set(actual)].sort((a, b) => a - b);
  return (
    expected.length === plan.steps.length &&
    completed.length === actual.length &&
    expected.length === completed.length &&
    expected.every((value, index) => value === completed[index])
  );
}

function requiredCheckpoints(plan: AgentRecordingPlan): string[] {
  return [
    ...new Set([
      ...plan.checkpoints,
      ...plan.steps.flatMap((step) => (step.checkpoint ? [step.checkpoint] : [])),
    ]),
  ];
}

function targetRequest(target: CapTarget) {
  if (target.kind !== 'window' || !target.application)
    throw new Error('The reviewed target is not a controllable application window.');
  const windowId = Number(target.id);
  if (!Number.isSafeInteger(windowId) || windowId <= 0)
    throw new Error('Cap did not return a usable target window ID.');
  return {
    displayName: target.application,
    windowId,
    windowTitle: target.name,
  };
}

function uniqueTarget(plan: AgentRecordingPlan, targets: CapTarget[]): CapTarget {
  if (plan.capture.targetKind !== 'window')
    throw new Error('Only application-window agent recording is supported.');
  const expected = normalized(plan.capture.targetApplication);
  if (!expected) throw new Error('A target application is required.');
  const matches = targets.filter(
    (target) => target.kind === 'window' && normalized(target.application) === expected,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'The reviewed target application is not available in Cap.'
        : 'The reviewed target application does not resolve to one unique Cap window.',
    );
  }
  return matches[0]!;
}

function assertSupportedScene(
  scene: Scene,
  plan: AgentRecordingPlan,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'darwin') throw new Error('Agent recording currently requires macOS.');
  if (scene.type === 'terminal') throw new Error('Terminal scenes cannot use agent recording.');
  if (plan.stale) throw new Error('The recording plan is stale and must be reviewed again.');
  if (plan.capture.camera || plan.capture.microphone) {
    throw new Error(
      'Camera and microphone device selection is not supported by this recording workflow.',
    );
  }
  if (!plan.capture.cursor) {
    throw new Error(
      'Cursor-disabled capture is not supported by the installed Cap recording contract.',
    );
  }
}

function helperEnvironment(
  capability: DesktopDriverCapability,
  baseUrl: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'USER',
    'LOGNAME',
    'SHELL',
    'CODEX_HOME',
    'TERM',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    [DESKTOP_DRIVER_ENV.baseUrl]: baseUrl,
    [DESKTOP_DRIVER_ENV.sessionId]: capability.sessionId,
    [DESKTOP_DRIVER_ENV.token]: capability.token,
  };
}

function rehearsalPrompt(plan: AgentRecordingPlan): string {
  return `Rehearse this reviewed VPA scene without starting or controlling Cap.\n\nReviewed plan:\n${JSON.stringify(plan, null, 2)}\n\nUse only these exact helper commands:\n- node scripts/vpa-desktop-driver.mjs inspect\n- node scripts/vpa-desktop-driver.mjs screenshot\n- node scripts/vpa-desktop-driver.mjs click --element <index>\n- node scripts/vpa-desktop-driver.mjs set-value --element <index> --value <text>\n- node scripts/vpa-desktop-driver.mjs type-text --value <text>\n- node scripts/vpa-desktop-driver.mjs press-key --key <allowed-key>\nConnection authority is supplied only in VPA_DESKTOP_DRIVER_BASE_URL, VPA_DESKTOP_DRIVER_SESSION_ID, and VPA_DESKTOP_DRIVER_TOKEN. Inspect before each action, complete every step and checkpoint, reset to the starting state, then report evidence.`;
}

function recordingPrompt(plan: AgentRecordingPlan): string {
  return `Recording is active. Execute the already rehearsed reviewed plan exactly once through the VPA desktop helper. Do not run Cap commands. Complete every step and checkpoint, then report structured execution evidence.\n\nReviewed plan:\n${JSON.stringify(plan, null, 2)}`;
}

export function createAgentRecordingCoordinator(
  deps: AgentRecordingCoordinatorDeps,
): AgentRecordingCoordinator {
  const now = deps.now ?? (() => new Date());
  const delay = deps.delay ?? abortableDelay;
  const platform = deps.platform ?? process.platform;
  const driverBaseUrl =
    deps.driverBaseUrl ?? `http://127.0.0.1:${process.env.VPA_SERVER_PORT ?? '3000'}`;
  const parsedDriverBaseUrl = new URL(driverBaseUrl);
  if (
    parsedDriverBaseUrl.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(
      parsedDriverBaseUrl.hostname.toLowerCase(),
    ) ||
    parsedDriverBaseUrl.username ||
    parsedDriverBaseUrl.password
  ) {
    throw new Error('Desktop driver base URL must be a plain loopback HTTP URL.');
  }
  const active = new Map<string, ActiveRun>();
  const reservations = new Set<string>();
  const contexts = new Map<string, SessionContext>();

  async function projectContext(projectId: string, sceneId: string) {
    const project = await deps.store.readProject(projectId);
    const storyboard = await loadStoryboard(project.path);
    const scene = storyboard?.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) throw new Error(`Scene not found: ${sceneId}`);
    return { project, scene };
  }

  function schedule(
    run: Omit<ActiveRun, 'promise'>,
    work: (activeRun: ActiveRun) => Promise<void>,
  ): ActiveRun {
    const key = sceneKey(run.projectId, run.sceneId);
    const complete = { ...run, promise: Promise.resolve() } as ActiveRun;
    active.set(key, complete);
    complete.promise = Promise.resolve()
      .then(() => work(complete))
      .finally(() => {
        if (active.get(key) === complete) active.delete(key);
      });
    return complete;
  }

  async function revoke(run: Pick<ActiveRun, 'sessionId' | 'driverSessionId'>): Promise<void> {
    const context = contexts.get(run.sessionId);
    const driverSessionId = run.driverSessionId ?? context?.driver.sessionId;
    if (!driverSessionId) return;
    await deps.desktop.revoke(run.sessionId, driverSessionId);
    contexts.delete(run.sessionId);
  }

  async function stopOnce(run: ActiveRun, stored?: SessionInternal): Promise<void> {
    const recordingId = run.recordingId ?? stored?.recordingId;
    if (!recordingId || run.stopAttempted || stored?.recordingStopped) return;
    run.stopAttempted = true;
    await updateAgentRecordingSessionInternal(
      run.projectPath,
      run.projectId,
      run.sceneId,
      run.sessionId,
      {
        stopAttempted: true,
        phase: 'stopping-recording',
        message: 'Stopping the exact Cap recording.',
      },
    ).catch(() => undefined);
    const stopped = await deps.cap.stopRecording(recordingId);
    await persistAgentRecordingStopped(
      run.projectPath,
      run.projectId,
      run.sceneId,
      run.sessionId,
      recordingId,
      stopped.projectPath,
    );
  }

  async function terminate(
    run: ActiveRun,
    state: 'failed' | 'interrupted',
    error: unknown,
  ): Promise<void> {
    const stored = await readStoredAgentRecordingSession(run.projectPath, run.sessionId).catch(
      () => undefined,
    );
    let diagnostic = errorMessage(error, [
      run.projectPath,
      deps.workspaceRoot,
      stored?.capProjectPath,
      stored?.exportPath,
    ]);
    try {
      await stopOnce(run, stored);
    } catch (stopError) {
      diagnostic = `${diagnostic} Cap stop also failed: ${errorMessage(stopError, [run.projectPath, deps.workspaceRoot, stored?.capProjectPath, stored?.exportPath])}`;
    }
    try {
      const latest = await readStoredAgentRecordingSession(run.projectPath, run.sessionId);
      if (!['completed', 'failed', 'interrupted'].includes(latest.state)) {
        await transitionAgentRecordingSession(
          run.projectPath,
          run.projectId,
          run.sceneId,
          run.sessionId,
          state,
          { phase: state, message: diagnostic },
        );
      }
    } finally {
      await revoke(run).catch(() => undefined);
    }
  }

  async function freshCapTarget(plan: AgentRecordingPlan): Promise<CapTarget> {
    const status = await deps.cap.getStatus(true);
    if (!status.installed || status.state !== 'ready' || !status.captureReady) {
      throw new Error(status.message || 'Cap is not ready for recording.');
    }
    const doctor = await deps.cap.doctor();
    if (!doctor.captureReady || doctor.missingPermissions.length > 0) {
      throw new Error(
        `Cap is missing required permissions: ${doctor.missingPermissions.join(', ') || 'capture readiness'}.`,
      );
    }
    return uniqueTarget(plan, await deps.cap.targets());
  }

  async function verifyRehearsal(
    plan: AgentRecordingPlan,
    target: CapTarget,
    capability: DesktopDriverCapability,
    evidence: Awaited<ReturnType<CodexSceneRunner['rehearse']>>['evidence'],
  ): Promise<void> {
    if (!evidence.success || !evidence.resetConfirmed)
      throw new Error(evidence.diagnostic || 'Codex did not complete and reset the rehearsal.');
    if (!exactStepIndexes(plan, evidence.completedStepIndexes))
      throw new Error('Codex did not rehearse every reviewed step exactly once.');
    const checkpoints = requiredCheckpoints(plan);
    if (
      evidence.checkpoints.some((checkpoint) => !checkpoint.passed) ||
      checkpoints.some(
        (description) =>
          !evidence.checkpoints.some(
            (checkpoint) => checkpoint.description === description && checkpoint.passed,
          ),
      )
    ) {
      throw new Error('Codex did not pass every reviewed checkpoint.');
    }
    const inspected = await deps.desktop.inspect(capability.sessionId, capability.token);
    const expectedApplication = normalized(plan.capture.targetApplication);
    if (
      normalized(evidence.targetApplication) !== expectedApplication ||
      normalized(inspected.target.displayName) !== expectedApplication ||
      evidence.windowTitle !== target.name ||
      inspected.target.windowTitle !== target.name ||
      evidence.windowTitle !== inspected.target.windowTitle ||
      evidence.windowBounds.x !== inspected.windowBounds.x ||
      evidence.windowBounds.y !== inspected.windowBounds.y ||
      evidence.windowBounds.width !== inspected.windowBounds.width ||
      evidence.windowBounds.height !== inspected.windowBounds.height ||
      (target.width !== undefined && evidence.windowBounds.width !== target.width) ||
      (target.height !== undefined && evidence.windowBounds.height !== target.height)
    ) {
      throw new Error('Final target inspection did not match the rehearsal evidence.');
    }
  }

  return {
    async rehearse(projectId, sceneId, update) {
      const key = sceneKey(projectId, sceneId);
      if (active.has(key) || reservations.has(key))
        throw new Error('An agent recording operation is already active for this scene.');
      reservations.add(key);
      try {
        const { project, scene } = await projectContext(projectId, sceneId);
        const current = await getCurrentAgentRecordingSession(project.path, projectId, sceneId);
        if (current && !['completed', 'failed', 'interrupted'].includes(current.state)) {
          throw new Error('An agent recording session is already active for this scene.');
        }
        const editable = AgentRecordingPlanUpdateSchema.parse(update);
        const plan = await saveAgentRecordingPlan(project.path, project, scene, editable);
        assertSupportedScene(scene, plan, platform);
        const fingerprint = planFingerprint(plan);
        const session = await createAgentRecordingSession(project.path, projectId, sceneId);
        const run = schedule(
          {
            sessionId: session.id,
            projectId,
            sceneId,
            projectPath: project.path,
            controller: new AbortController(),
            stopAttempted: false,
          },
          async (currentRun) => {
            try {
              await updateAgentRecordingSessionInternal(
                project.path,
                projectId,
                sceneId,
                session.id,
                {
                  planFingerprint: fingerprint,
                  phase: 'checking-cap',
                  message: 'Checking Cap and the reviewed target.',
                },
              );
              const target = await freshCapTarget(plan);
              currentRun.controller.signal.throwIfAborted();
              const capability = await deps.desktop.createFromWindowOwner({
                agentRecordingSessionId: session.id,
                projectId,
                sceneId,
                planFingerprint: fingerprint,
                target: targetRequest(target),
                operations: [...ALL_DRIVER_OPERATIONS],
                phase: 'rehearsal',
              });
              currentRun.driverSessionId = capability.sessionId;
              contexts.set(session.id, { target, driver: capability });
              await updateAgentRecordingSessionInternal(
                project.path,
                projectId,
                sceneId,
                session.id,
                {
                  driverSessionId: capability.sessionId,
                  targetApplicationId: capability.target.bundleId,
                  phase: 'rehearsing',
                  message: 'Codex is rehearsing the reviewed scene.',
                },
              );
              const scratch = path.join(
                project.path,
                '.tmp',
                'agent-recording',
                session.id,
                'rehearsal',
              );
              const result = await deps.codex.rehearse(
                rehearsalPrompt(plan),
                scratch,
                helperEnvironment(capability, driverBaseUrl),
                currentRun.controller.signal,
              );
              currentRun.controller.signal.throwIfAborted();
              await verifyRehearsal(plan, target, capability, result.evidence);
              await transitionAgentRecordingSession(
                project.path,
                projectId,
                sceneId,
                session.id,
                'awaiting_confirmation',
                {
                  planFingerprint: fingerprint,
                  rehearsal: result.evidence,
                  codexThreadId: result.threadId,
                  driverSessionId: capability.sessionId,
                  targetApplicationId: capability.target.bundleId,
                  phase: 'awaiting-confirmation',
                  message: 'Rehearsal passed. Review the verified target and capture settings.',
                },
              );
            } catch (error) {
              await terminate(
                currentRun,
                currentRun.controller.signal.aborted ? 'interrupted' : 'failed',
                error,
              );
            }
          },
        );
        void run.promise;
        return session;
      } finally {
        reservations.delete(key);
      }
    },

    async confirmAndRecord(projectId, sceneId, sessionId, input) {
      const confirmation = AgentRecordingConfirmRequestSchema.parse(input);
      const key = sceneKey(projectId, sceneId);
      if (active.has(key) || reservations.has(key))
        throw new Error('An agent recording operation is already active for this scene.');
      reservations.add(key);
      try {
        const { project, scene } = await projectContext(projectId, sceneId);
        const stored = await readStoredAgentRecordingSession(project.path, sessionId);
        if (stored.projectId !== projectId || stored.sceneId !== sceneId)
          throw new Error('Recording session does not belong to this scene.');
        if (stored.state !== 'awaiting_confirmation')
          throw new Error('Recording confirmation requires an awaiting-confirmation session.');
        if (!stored.planFingerprint || confirmation.planFingerprint !== stored.planFingerprint)
          throw new Error('Recording confirmation does not match the rehearsed plan.');
        if (!stored.codexThreadId || !stored.rehearsal?.success)
          throw new Error('Recording confirmation requires verified rehearsal evidence.');
        const codexThreadId = stored.codexThreadId;
        const context = contexts.get(sessionId);
        if (!context)
          throw new Error('The rehearsal capability is no longer available; rehearse again.');

        const run = schedule(
          {
            sessionId,
            projectId,
            sceneId,
            projectPath: project.path,
            controller: new AbortController(),
            stopAttempted: stored.stopAttempted === true,
            driverSessionId: context.driver.sessionId,
          },
          async (currentRun) => {
            try {
              const currentPlan = await readAgentRecordingPlan(project.path, project, scene);
              assertSupportedScene(scene, currentPlan, platform);
              if (planFingerprint(currentPlan) !== stored.planFingerprint)
                throw new Error('The reviewed plan changed after rehearsal; rehearse again.');
              const target = await freshCapTarget(currentPlan);
              currentRun.controller.signal.throwIfAborted();
              if (
                target.id !== context.target.id ||
                target.kind !== context.target.kind ||
                target.name !== context.target.name ||
                target.application !== context.target.application
              ) {
                throw new Error('The Cap target changed after rehearsal; rehearse again.');
              }

              await deps.desktop.revoke(sessionId, context.driver.sessionId);
              const capability = await deps.desktop.createFromWindowOwner({
                agentRecordingSessionId: sessionId,
                projectId,
                sceneId,
                planFingerprint: stored.planFingerprint,
                target: targetRequest(target),
                operations: [...ALL_DRIVER_OPERATIONS],
                phase: 'recording',
              });
              currentRun.driverSessionId = capability.sessionId;
              contexts.set(sessionId, { target, driver: capability });
              await updateAgentRecordingSessionInternal(
                project.path,
                projectId,
                sceneId,
                sessionId,
                {
                  driverSessionId: capability.sessionId,
                  phase: 'starting-recording',
                  message: 'Starting the confirmed Cap recording.',
                },
              );

              const captureDirectory = path.join(
                project.path,
                'recording-plans',
                'captures',
                sessionId,
              );
              await mkdir(captureDirectory, { recursive: true });
              const started = await deps.cap.startRecording({
                targetKind: target.kind,
                targetId: target.id,
                fps: currentPlan.capture.fps,
                projectPath: path.join(captureDirectory, 'take.cap'),
                systemAudio: currentPlan.capture.systemAudio,
              });
              currentRun.recordingId = started.recordingId;
              currentRun.controller.signal.throwIfAborted();
              const capturedAt = now().toISOString();
              await persistAgentRecordingIdentity(
                project.path,
                projectId,
                sceneId,
                sessionId,
                started,
                capturedAt,
              );
              await transitionAgentRecordingSession(
                project.path,
                projectId,
                sceneId,
                sessionId,
                'recording',
                {
                  confirmedCapture: true,
                  planFingerprint: stored.planFingerprint,
                  driverSessionId: capability.sessionId,
                  phase: 'recording',
                  message: 'Recording the rehearsed scene.',
                },
              );

              await delay(currentPlan.leadInSec * 1_000, currentRun.controller.signal);
              const evidence = await deps.codex.resumeForRecording(
                codexThreadId,
                recordingPrompt(currentPlan),
                helperEnvironment(capability, driverBaseUrl),
                currentRun.controller.signal,
              );
              if (
                !evidence.success ||
                !exactStepIndexes(currentPlan, evidence.completedStepIndexes) ||
                evidence.checkpoints.some((checkpoint) => !checkpoint.passed) ||
                requiredCheckpoints(currentPlan).some(
                  (description) =>
                    !evidence.checkpoints.some(
                      (checkpoint) => checkpoint.description === description && checkpoint.passed,
                    ),
                )
              ) {
                throw new Error(
                  evidence.diagnostic || 'Codex did not complete the recorded scene safely.',
                );
              }
              await delay(currentPlan.tailSec * 1_000, currentRun.controller.signal);
              currentRun.stopAttempted = true;
              await updateAgentRecordingSessionInternal(
                project.path,
                projectId,
                sceneId,
                sessionId,
                {
                  stopAttempted: true,
                  phase: 'stopping-recording',
                  message: 'Stopping the exact Cap recording.',
                },
              );
              const stopped = await deps.cap.stopRecording(started.recordingId);
              await persistAgentRecordingStopped(
                project.path,
                projectId,
                sceneId,
                sessionId,
                started.recordingId,
                stopped.projectPath,
              );
              await transitionAgentRecordingSession(
                project.path,
                projectId,
                sceneId,
                sessionId,
                'exporting',
                {
                  capProjectPath: stopped.projectPath,
                  recordingStopped: true,
                  phase: 'validating',
                  message: 'Validating the captured Cap project.',
                },
              );
              await deps.cap.validateProject(stopped.projectPath);
              const exportPath = path.join(captureDirectory, 'take.mp4');
              await deps.cap.exportProject(
                stopped.projectPath,
                exportPath,
                currentRun.controller.signal,
              );
              await transitionAgentRecordingSession(
                project.path,
                projectId,
                sceneId,
                sessionId,
                'attaching',
                {
                  exportPath,
                  retryAvailable: 'attachment',
                  phase: 'attaching',
                  message: 'Attaching the verified recording to the scene.',
                },
              );
              const metadata = await deps.probeVideo(exportPath);
              const ingested = await deps.ingest(project.path, sceneId, exportPath, metadata, {
                source_kind: 'cap-agent',
                capture_session_id: sessionId,
                captured_at: capturedAt,
              });
              await verifyIngestion(
                project.path,
                sceneId,
                sessionId,
                capturedAt,
                metadata,
                ingested,
              );
              await transitionAgentRecordingSession(
                project.path,
                projectId,
                sceneId,
                sessionId,
                'completed',
                {
                  retryAvailable: undefined,
                  phase: 'completed',
                  message: 'Recording attached and verified.',
                },
              );
              await revoke(currentRun);
            } catch (error) {
              const latest = await readStoredAgentRecordingSession(project.path, sessionId).catch(
                () => undefined,
              );
              if (latest?.state === 'exporting' && !currentRun.controller.signal.aborted) {
                await updateAgentRecordingSessionInternal(
                  project.path,
                  projectId,
                  sceneId,
                  sessionId,
                  {
                    retryAvailable: latest.capProjectPath ? 'export' : undefined,
                    phase: 'export-interrupted',
                    message: `Export stopped: ${errorMessage(error, [project.path, deps.workspaceRoot, latest.capProjectPath, latest.exportPath])}`,
                  },
                ).catch(() => undefined);
                await revoke(currentRun).catch(() => undefined);
                return;
              }
              if (latest?.state === 'attaching' && !currentRun.controller.signal.aborted) {
                await updateAgentRecordingSessionInternal(
                  project.path,
                  projectId,
                  sceneId,
                  sessionId,
                  {
                    retryAvailable: latest.exportPath ? 'attachment' : undefined,
                    phase: 'attachment-interrupted',
                    message: `Attachment stopped: ${errorMessage(error, [project.path, deps.workspaceRoot, latest.capProjectPath, latest.exportPath])}`,
                  },
                ).catch(() => undefined);
                await revoke(currentRun).catch(() => undefined);
                return;
              }
              await terminate(
                currentRun,
                currentRun.controller.signal.aborted ? 'interrupted' : 'failed',
                error,
              );
            }
          },
        );
        void run.promise;
        return AgentRecordingSessionSchemaSafe(stored);
      } finally {
        reservations.delete(key);
      }
    },

    async cancel(projectId, sceneId, sessionId) {
      const key = sceneKey(projectId, sceneId);
      const initiallyRunning = active.get(key);
      if (initiallyRunning?.sessionId === sessionId) {
        initiallyRunning.controller.abort(new Error('Recording cancelled by the user.'));
      }
      const { project } = await projectContext(projectId, sceneId);
      const stored = await readStoredAgentRecordingSession(project.path, sessionId);
      if (stored.projectId !== projectId || stored.sceneId !== sceneId)
        throw new Error('Recording session does not belong to this scene.');
      if (['completed', 'failed', 'interrupted'].includes(stored.state))
        return AgentRecordingSessionSchemaSafe(stored);
      const running = active.get(key);
      if (running && running.sessionId === sessionId) {
        if (!running.controller.signal.aborted)
          running.controller.abort(new Error('Recording cancelled by the user.'));
        await running.promise;
      } else {
        const run: ActiveRun = {
          sessionId,
          projectId,
          sceneId,
          projectPath: project.path,
          controller: new AbortController(),
          promise: Promise.resolve(),
          recordingId: stored.recordingId,
          stopAttempted: false,
          driverSessionId: stored.driverSessionId,
        };
        await terminate(run, 'interrupted', new Error('Recording cancelled by the user.'));
      }
      return AgentRecordingSessionSchemaSafe(
        await readStoredAgentRecordingSession(project.path, sessionId),
      );
    },

    async reconcile() {
      const tracker = await deps.store.readTracker();
      for (const project of tracker.projects) {
        const sessions = await listStoredAgentRecordingSessions(project.path);
        for (const stored of sessions) {
          if (['completed', 'failed', 'interrupted'].includes(stored.state)) {
            if (stored.recordingId && !stored.recordingStopped) {
              const terminalRun: ActiveRun = {
                sessionId: stored.id,
                projectId: stored.projectId,
                sceneId: stored.sceneId,
                projectPath: project.path,
                controller: new AbortController(),
                promise: Promise.resolve(),
                recordingId: stored.recordingId,
                stopAttempted: false,
                driverSessionId: stored.driverSessionId,
              };
              await stopOnce(terminalRun, stored).catch(() => undefined);
            }
            if (stored.driverSessionId)
              await deps.desktop.revoke(stored.id, stored.driverSessionId).catch(() => undefined);
            continue;
          }
          if (stored.state === 'exporting' || stored.state === 'attaching') {
            await updateAgentRecordingSessionInternal(
              project.path,
              stored.projectId,
              stored.sceneId,
              stored.id,
              {
                retryAvailable:
                  stored.state === 'exporting' && stored.capProjectPath
                    ? 'export'
                    : stored.state === 'attaching' && stored.exportPath
                      ? 'attachment'
                      : undefined,
                phase: `${stored.state}-interrupted`,
                message:
                  stored.state === 'exporting'
                    ? stored.capProjectPath
                      ? 'Export was interrupted. Retry is available only for the verified Cap project.'
                      : 'Export was interrupted, but no verified Cap project is available to retry.'
                    : stored.exportPath
                      ? 'Attachment was interrupted. Retry is available only for the verified export.'
                      : 'Attachment was interrupted, but no verified export is available to retry.',
              },
            );
            if (stored.driverSessionId)
              await deps.desktop.revoke(stored.id, stored.driverSessionId).catch(() => undefined);
            continue;
          }
          const run: ActiveRun = {
            sessionId: stored.id,
            projectId: stored.projectId,
            sceneId: stored.sceneId,
            projectPath: project.path,
            controller: new AbortController(),
            promise: Promise.resolve(),
            recordingId: stored.recordingId,
            stopAttempted: false,
            driverSessionId: stored.driverSessionId,
          };
          await terminate(
            run,
            'interrupted',
            new Error('Server restart interrupted this recording workflow.'),
          );
        }
      }
    },
  };
}

function AgentRecordingSessionSchemaSafe(value: SessionInternal): AgentRecordingSession {
  return AgentRecordingSessionSchema.parse(value);
}

async function verifyIngestion(
  projectPath: string,
  sceneId: string,
  sessionId: string,
  capturedAt: string,
  metadata: VideoMetadata,
  result: IngestResult,
): Promise<void> {
  if (
    result.sceneId !== sceneId ||
    !result.relativePath ||
    result.metadata.duration_sec !== metadata.duration_sec ||
    result.metadata.width !== metadata.width ||
    result.metadata.height !== metadata.height ||
    result.metadata.codec !== metadata.codec ||
    result.metadata.fps !== metadata.fps ||
    result.metadata.size_bytes !== metadata.size_bytes
  ) {
    throw new Error('Recording ingestion returned inconsistent metadata.');
  }
  const storyboard = await loadStoryboard(projectPath);
  const recording = storyboard?.scenes.find((scene) => scene.id === sceneId)?.recording;
  if (
    !recording ||
    recording.source !== result.relativePath ||
    recording.source_kind !== 'cap-agent' ||
    recording.capture_session_id !== sessionId ||
    recording.captured_at !== capturedAt ||
    recording.duration_sec !== metadata.duration_sec
  ) {
    throw new Error('Attached recording metadata could not be verified.');
  }
}
