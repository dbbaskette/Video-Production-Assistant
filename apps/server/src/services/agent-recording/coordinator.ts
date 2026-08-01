import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
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
import { DESKTOP_DRIVER_ENV, type DesktopDriverCapability, type ResolvedDesktopDriverTarget } from '../desktop-driver/types.js';
import type { DesktopDriverSessionManager } from '../desktop-driver/session.js';
import type { CodexSceneRunner } from './codex-runner.js';
import { readAgentRecordingPlan, saveAgentRecordingPlan } from './plan.js';
import {
  appendAgentRecordingPrivateDiagnostic,
  createAgentRecordingSession,
  getCurrentAgentRecordingSession,
  listStoredAgentRecordingSessions,
  persistAgentRecordingIdentity,
  persistAgentRecordingStopped,
  readStoredAgentRecordingSession,
  transitionAgentRecordingSession,
  updateAgentRecordingSessionInternal,
  type AgentRecordingPrivateDiagnosticCategory,
} from './session.js';
import { AgentRecordingDomainError } from './errors.js';

const ALL_DRIVER_OPERATIONS = [
  'inspect',
  'screenshot',
  'click',
  'set-value',
  'type-text',
  'press-key',
] as const;

type SessionInternal = Awaited<ReturnType<typeof readStoredAgentRecordingSession>>;
type RehearsedTargetIdentity = NonNullable<SessionInternal['rehearsedTargetIdentity']>;

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
  publicFailureMessage: string;
  privateFailureCategory: AgentRecordingPrivateDiagnosticCategory;
  attachmentCritical?: boolean;
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
  recoverAttachment(
    projectId: string,
    sceneId: string,
    sessionId: string,
    input: { capturedAt: string; uploadedPath: string },
  ): Promise<IngestResult>;
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

function publicMessage(value: string): string {
  return Buffer.from(value.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('\t', ' ').replaceAll('\0', ' ')).subarray(0, 500).toString('utf8');
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

function targetIdentity(target: CapTarget, desktop: ResolvedDesktopDriverTarget): RehearsedTargetIdentity {
  if (target.kind !== 'window' || !target.application) throw new Error('Target identity is incomplete.');
  return {
    cap: {
      kind: 'window', id: target.id, name: target.name, application: target.application,
      ...(target.width === undefined ? {} : { width: target.width }),
      ...(target.height === undefined ? {} : { height: target.height }),
    },
    desktop: {
      bundleId: desktop.bundleId, displayName: desktop.displayName, processId: desktop.processId,
      windowId: desktop.windowId, windowTitle: desktop.windowTitle, bounds: { ...desktop.bounds },
    },
  };
}

function sameTargetIdentity(left: RehearsedTargetIdentity, right: RehearsedTargetIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fileEvidence(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error('Export is not a readable nonempty file.');
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return { sizeBytes: info.size, sha256: hash.digest('hex') };
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

function assertSupportedWorkflow(
  scene: Scene,
  capture: AgentRecordingPlanUpdate['capture'],
  platform: NodeJS.Platform,
): void {
  if (platform !== 'darwin') {
    throw new AgentRecordingDomainError('INVALID_PLAN', 'Agent recording currently requires macOS.');
  }
  if (scene.type === 'terminal') {
    throw new AgentRecordingDomainError('INVALID_PLAN', 'Terminal scenes cannot use agent recording.');
  }
  if (capture.targetKind !== 'window') {
    throw new AgentRecordingDomainError('INVALID_PLAN', 'Only application-window agent recording is supported.');
  }
  if (!capture.targetApplication.trim()) {
    throw new AgentRecordingDomainError('INVALID_PLAN', 'A target application is required.');
  }
  if (capture.camera || capture.microphone) {
    throw new AgentRecordingDomainError(
      'INVALID_PLAN',
      'Camera and microphone device selection is not supported by this recording workflow.',
    );
  }
  if (!capture.cursor) {
    throw new AgentRecordingDomainError(
      'INVALID_PLAN',
      'Cursor-disabled capture is not supported by the installed Cap recording contract.',
    );
  }
}

function assertSupportedScene(
  scene: Scene,
  plan: AgentRecordingPlan,
  platform: NodeJS.Platform,
): void {
  assertSupportedWorkflow(scene, plan.capture, platform);
  if (plan.stale) {
    throw new AgentRecordingDomainError(
      'CONFLICT',
      'The recording plan is stale and must be reviewed again.',
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
    const tracker = await deps.store.readTracker();
    if (!tracker.projects.some((candidate) => candidate.id === projectId)) {
      throw new AgentRecordingDomainError('NOT_FOUND', `Project not found: ${projectId}`);
    }
    const project = await deps.store.readProject(projectId);
    const storyboard = await loadStoryboard(project.path);
    const scene = storyboard?.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) throw new AgentRecordingDomainError('NOT_FOUND', `Scene not found: ${sceneId}`);
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

  async function preservePrivateFailure(
    run: ActiveRun,
    error: unknown,
    category: AgentRecordingPrivateDiagnosticCategory = run.privateFailureCategory,
  ): Promise<void> {
    const stored = await readStoredAgentRecordingSession(run.projectPath, run.sessionId).catch(() => undefined);
    const context = contexts.get(run.sessionId);
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await appendAgentRecordingPrivateDiagnostic(
      run.projectPath,
      run.projectId,
      run.sceneId,
      run.sessionId,
      { category, phase: stored?.phase ?? stored?.state ?? category, detail },
      [
        run.projectPath, deps.workspaceRoot, run.projectId, run.sceneId, run.sessionId,
        run.driverSessionId ?? '', run.recordingId ?? '', context?.driver.sessionId ?? '',
        context?.driver.token ?? '', stored?.codexThreadId ?? '', stored?.driverSessionId ?? '',
        stored?.recordingId ?? '', stored?.capProjectPath ?? '', stored?.exportPath ?? '',
        context?.target.id ?? '', String(context?.driver.target.windowId ?? ''),
        String(context?.driver.target.processId ?? ''), stored?.rehearsedTargetIdentity?.cap.id ?? '',
        String(stored?.rehearsedTargetIdentity?.desktop.windowId ?? ''),
        String(stored?.rehearsedTargetIdentity?.desktop.processId ?? ''),
      ],
    ).catch(() => undefined);
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
    error?: unknown,
  ): Promise<void> {
    const stored = await readStoredAgentRecordingSession(run.projectPath, run.sessionId).catch(
      () => undefined,
    );
    let diagnostic = state === 'interrupted'
      ? 'Recording workflow cancelled or interrupted.'
      : run.publicFailureMessage;
    if (error !== undefined) await preservePrivateFailure(run, error);
    try {
      await stopOnce(run, stored);
    } catch (stopError) {
      await preservePrivateFailure(run, stopError, 'cap');
      diagnostic = `${diagnostic} Cap could not confirm that the exact recording stopped.`;
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
          { phase: state, message: publicMessage(diagnostic) },
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
  ): Promise<{ evidence: AgentRecordingSession['rehearsal']; identity: RehearsedTargetIdentity }> {
    if (!evidence.success || !evidence.resetConfirmed)
      throw new Error('Codex did not complete and reset the rehearsal.');
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
    const identity = targetIdentity(target, capability.target);
    return {
      identity,
      evidence: {
        success: true,
        targetApplication: plan.capture.targetApplication,
        windowTitle: target.name,
        windowBounds: { ...inspected.windowBounds },
        completedStepIndexes: plan.steps.map((step) => step.index),
        checkpoints: requiredCheckpoints(plan).map((description) => ({ description, passed: true })),
        resetConfirmed: true,
        reviewedCapture: { ...plan.capture },
        reviewedSteps: plan.steps.map((step) => ({ ...step })),
      },
    };
  }

  return {
    async rehearse(projectId, sceneId, update) {
      const key = sceneKey(projectId, sceneId);
      if (active.has(key) || reservations.has(key))
        throw new AgentRecordingDomainError('CONFLICT', 'An agent recording operation is already active for this scene.');
      reservations.add(key);
      try {
        const { project, scene } = await projectContext(projectId, sceneId);
        const current = await getCurrentAgentRecordingSession(project.path, projectId, sceneId);
        if (current && !['completed', 'failed', 'interrupted'].includes(current.state)) {
          throw new AgentRecordingDomainError('CONFLICT', 'An agent recording session is already active for this scene.');
        }
        const parsed = AgentRecordingPlanUpdateSchema.safeParse(update);
        if (!parsed.success) {
          throw new AgentRecordingDomainError('INVALID_PLAN', 'Recording plan is invalid.');
        }
        const editable = parsed.data;
        assertSupportedWorkflow(scene, editable.capture, platform);
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
            publicFailureMessage: 'Rehearsal could not be verified.',
            privateFailureCategory: 'local',
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
              currentRun.publicFailureMessage = 'Cap or the reviewed target was not ready for rehearsal.';
              currentRun.privateFailureCategory = 'cap';
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
              currentRun.publicFailureMessage = 'Codex rehearsal or final target verification failed.';
              currentRun.privateFailureCategory = 'codex';
              const result = await deps.codex.rehearse(
                rehearsalPrompt(plan),
                scratch,
                helperEnvironment(capability, driverBaseUrl),
                currentRun.controller.signal,
              );
              currentRun.controller.signal.throwIfAborted();
              const verified = await verifyRehearsal(plan, target, capability, result.evidence);
              await transitionAgentRecordingSession(
                project.path,
                projectId,
                sceneId,
                session.id,
                'awaiting_confirmation',
                {
                  planFingerprint: fingerprint,
                  rehearsal: verified.evidence,
                  rehearsedTargetIdentity: verified.identity,
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
      const parsed = AgentRecordingConfirmRequestSchema.safeParse(input);
      if (!parsed.success) {
        throw new AgentRecordingDomainError('INVALID_CONFIRMATION', 'Recording confirmation is invalid.');
      }
      const confirmation = parsed.data;
      const key = sceneKey(projectId, sceneId);
      if (active.has(key) || reservations.has(key))
        throw new AgentRecordingDomainError('CONFLICT', 'An agent recording operation is already active for this scene.');
      reservations.add(key);
      try {
        const { project, scene } = await projectContext(projectId, sceneId);
        const stored = await readStoredAgentRecordingSession(project.path, sessionId);
        if (stored.projectId !== projectId || stored.sceneId !== sceneId)
          throw new AgentRecordingDomainError('NOT_FOUND', 'Recording session does not belong to this scene.');
        if (stored.state !== 'awaiting_confirmation')
          throw new AgentRecordingDomainError('CONFLICT', 'Recording confirmation requires an awaiting-confirmation session.');
        if (!stored.planFingerprint || confirmation.planFingerprint !== stored.planFingerprint)
          throw new AgentRecordingDomainError('INVALID_CONFIRMATION', 'Recording confirmation does not match the rehearsed plan.');
        if (!stored.codexThreadId || !stored.rehearsal?.success)
          throw new AgentRecordingDomainError('CONFLICT', 'Recording confirmation requires verified rehearsal evidence.');
        if (!stored.rehearsedTargetIdentity)
          throw new AgentRecordingDomainError('CONFLICT', 'Recording confirmation requires exact rehearsed target identity.');
        const rehearsedTargetIdentity = stored.rehearsedTargetIdentity;
        const codexThreadId = stored.codexThreadId;
        const context = contexts.get(sessionId);
        if (!context)
          throw new AgentRecordingDomainError('CONFLICT', 'The rehearsal capability is no longer available; rehearse again.');

        const run = schedule(
          {
            sessionId,
            projectId,
            sceneId,
            projectPath: project.path,
            controller: new AbortController(),
            stopAttempted: stored.stopAttempted === true,
            driverSessionId: context.driver.sessionId,
            publicFailureMessage: 'Confirmed recording could not start safely.',
            privateFailureCategory: 'local',
          },
          async (currentRun) => {
            try {
              const currentPlan = await readAgentRecordingPlan(project.path, project, scene);
              assertSupportedScene(scene, currentPlan, platform);
              if (planFingerprint(currentPlan) !== stored.planFingerprint)
                throw new Error('The reviewed plan changed after rehearsal; rehearse again.');
              currentRun.privateFailureCategory = 'cap';
              const target = await freshCapTarget(currentPlan);
              currentRun.controller.signal.throwIfAborted();
              const binding = {
                agentRecordingSessionId: sessionId, projectId, sceneId,
                planFingerprint: stored.planFingerprint, operations: [...ALL_DRIVER_OPERATIONS],
                phase: 'recording' as const,
              };
              currentRun.privateFailureCategory = 'desktop';
              const freshlyResolved = await deps.desktop.resolveWindowOwnerTarget(targetRequest(target), binding);
              currentRun.controller.signal.throwIfAborted();
              if (!sameTargetIdentity(rehearsedTargetIdentity, targetIdentity(target, freshlyResolved))) {
                throw new Error('The exact application/window identity changed after rehearsal.');
              }

              await deps.desktop.revoke(sessionId, context.driver.sessionId);
              const capability = await deps.desktop.create({ ...binding, target: freshlyResolved });
              currentRun.driverSessionId = capability.sessionId;
              if (!sameTargetIdentity(rehearsedTargetIdentity, targetIdentity(target, capability.target))) {
                throw new Error('The exact application/window identity changed during capability creation.');
              }
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
              currentRun.privateFailureCategory = 'cap';
              const started = await deps.cap.startRecording({
                targetKind: target.kind,
                targetId: target.id,
                fps: currentPlan.capture.fps,
                projectPath: path.join(captureDirectory, 'take.cap'),
                systemAudio: currentPlan.capture.systemAudio,
              });
              currentRun.recordingId = started.recordingId;
              const capturedAt = now().toISOString();
              await persistAgentRecordingIdentity(
                project.path,
                projectId,
                sceneId,
                sessionId,
                started,
                capturedAt,
              );
              currentRun.controller.signal.throwIfAborted();
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
              currentRun.publicFailureMessage = 'Codex could not complete the recorded scene.';
              currentRun.privateFailureCategory = 'codex';
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
                throw new Error('Codex did not complete the recorded scene safely.');
              }
              await delay(currentPlan.tailSec * 1_000, currentRun.controller.signal);
              currentRun.publicFailureMessage = 'Cap could not finalize the exact recording.';
              currentRun.privateFailureCategory = 'cap';
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
              currentRun.publicFailureMessage = 'Cap project validation failed.';
              currentRun.privateFailureCategory = 'cap';
              await deps.cap.validateProject(stopped.projectPath);
              currentRun.controller.signal.throwIfAborted();
              await updateAgentRecordingSessionInternal(project.path, projectId, sceneId, sessionId, {
                projectValidated: true,
                phase: 'exporting',
                message: 'Cap project validated. Exporting the recording.',
              });
              const exportPath = path.join(captureDirectory, 'take.mp4');
              currentRun.publicFailureMessage = 'Validated Cap project export failed.';
              currentRun.privateFailureCategory = 'export';
              await deps.cap.exportProject(
                stopped.projectPath,
                exportPath,
                currentRun.controller.signal,
              );
              currentRun.controller.signal.throwIfAborted();
              const exportVerified = await fileEvidence(exportPath);
              await transitionAgentRecordingSession(
                project.path,
                projectId,
                sceneId,
                sessionId,
                'attaching',
                {
                  exportPath,
                  exportVerified,
                  phase: 'attaching',
                  message: 'Attaching the verified recording to the scene.',
                },
              );
              currentRun.publicFailureMessage = 'Verified recording attachment failed.';
              currentRun.privateFailureCategory = 'attachment';
              currentRun.controller.signal.throwIfAborted();
              const metadata = await deps.probeVideo(exportPath);
              currentRun.controller.signal.throwIfAborted();
              if (metadata.size_bytes !== exportVerified.sizeBytes) throw new Error('Probed export size changed.');
              currentRun.attachmentCritical = true;
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
              await updateAgentRecordingSessionInternal(project.path, projectId, sceneId, sessionId, {
                ingestVerified: true,
                phase: 'verifying-attachment',
                message: 'Authoritative scene recording metadata verified.',
              });
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
              if (latest?.state === 'exporting' && latest.projectValidated && !currentRun.controller.signal.aborted) {
                await preservePrivateFailure(currentRun, error, 'export');
                await updateAgentRecordingSessionInternal(
                  project.path,
                  projectId,
                  sceneId,
                  sessionId,
                  {
                    retryAvailable: latest.capProjectPath ? 'export' : undefined,
                    phase: 'export-interrupted',
                    message: 'Validated Cap project export failed. Explicit export retry is available.',
                  },
                ).catch(() => undefined);
                await revoke(currentRun).catch(() => undefined);
                return;
              }
              if (latest?.state === 'attaching' && latest.exportVerified && !currentRun.controller.signal.aborted) {
                await preservePrivateFailure(currentRun, error, 'attachment');
                await updateAgentRecordingSessionInternal(
                  project.path,
                  projectId,
                  sceneId,
                  sessionId,
                  {
                    retryAvailable: latest.exportPath ? 'attachment' : undefined,
                    phase: 'attachment-interrupted',
                    message: 'Verified recording attachment failed. Explicit attachment retry is available.',
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
            } finally {
              currentRun.attachmentCritical = false;
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
      if (initiallyRunning?.sessionId === sessionId && !initiallyRunning.attachmentCritical) {
        initiallyRunning.controller.abort(new Error('Recording cancelled by the user.'));
      }
      const { project } = await projectContext(projectId, sceneId);
      const stored = await readStoredAgentRecordingSession(project.path, sessionId);
      if (stored.projectId !== projectId || stored.sceneId !== sceneId)
        throw new AgentRecordingDomainError('NOT_FOUND', 'Recording session does not belong to this scene.');
      if (['completed', 'failed', 'interrupted'].includes(stored.state))
        return AgentRecordingSessionSchemaSafe(stored);
      const running = active.get(key);
      if (running && running.sessionId === sessionId) {
        if (!running.attachmentCritical && !running.controller.signal.aborted)
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
          publicFailureMessage: 'Recording workflow failed.',
          privateFailureCategory: 'local',
        };
        await terminate(run, 'interrupted', new Error('Recording cancelled by the user.'));
      }
      return AgentRecordingSessionSchemaSafe(
        await readStoredAgentRecordingSession(project.path, sessionId),
      );
    },

    async recoverAttachment(projectId, sceneId, sessionId, input) {
      const key = sceneKey(projectId, sceneId);
      if (active.has(key) || reservations.has(key)) throw new Error('A recording operation is already active for this scene.');
      reservations.add(key);
      try {
        const { project } = await projectContext(projectId, sceneId);
        const stored = await readStoredAgentRecordingSession(project.path, sessionId);
        if (stored.projectId !== projectId || stored.sceneId !== sceneId) throw new Error('Recovery session does not belong to this scene.');
        if (stored.state !== 'attaching' || stored.retryAvailable !== 'attachment'
          || !stored.projectValidated || !stored.exportPath || !stored.exportVerified || !stored.capturedAt) {
          throw new Error('This session has no coordinator-verified attachment recovery available.');
        }
        if (input.capturedAt !== stored.capturedAt) throw new Error('Recovery capture time does not match the verified session.');
        let result: IngestResult | undefined;
        let failed = false;
        const run = schedule({
          sessionId, projectId, sceneId, projectPath: project.path,
          controller: new AbortController(), stopAttempted: false,
          publicFailureMessage: 'Verified recording recovery attachment failed.',
          privateFailureCategory: 'attachment',
        }, async (currentRun) => {
          try {
            const [uploadedEvidence, storedEvidence] = await Promise.all([
              fileEvidence(input.uploadedPath), fileEvidence(stored.exportPath!),
            ]);
            currentRun.controller.signal.throwIfAborted();
            if (uploadedEvidence.sha256 !== stored.exportVerified!.sha256
              || uploadedEvidence.sizeBytes !== stored.exportVerified!.sizeBytes
              || storedEvidence.sha256 !== stored.exportVerified!.sha256
              || storedEvidence.sizeBytes !== stored.exportVerified!.sizeBytes) {
              throw new Error('Recovery upload does not match the verified export.');
            }
            const metadata = await deps.probeVideo(stored.exportPath!);
            currentRun.controller.signal.throwIfAborted();
            if (metadata.size_bytes !== stored.exportVerified!.sizeBytes) throw new Error('Verified export metadata changed.');
            currentRun.attachmentCritical = true;
            result = await deps.ingest(project.path, sceneId, stored.exportPath!, metadata, {
              source_kind: 'cap-agent', capture_session_id: sessionId, captured_at: stored.capturedAt,
            });
            await verifyIngestion(project.path, sceneId, sessionId, stored.capturedAt!, metadata, result);
            await updateAgentRecordingSessionInternal(project.path, projectId, sceneId, sessionId, {
              ingestVerified: true, phase: 'verifying-attachment',
              message: 'Authoritative scene recording metadata verified.',
            });
            await transitionAgentRecordingSession(project.path, projectId, sceneId, sessionId, 'completed', {
              retryAvailable: undefined, phase: 'completed', message: 'Recording attached and verified.',
            });
          } catch (error) {
            failed = true;
            if (currentRun.controller.signal.aborted) {
              await terminate(currentRun, 'interrupted', error);
            } else {
              await preservePrivateFailure(currentRun, error, 'attachment');
              await updateAgentRecordingSessionInternal(project.path, projectId, sceneId, sessionId, {
                retryAvailable: 'attachment', phase: 'attachment-interrupted',
                message: 'Verified recording recovery attachment failed. Explicit retry remains available.',
              }).catch(() => undefined);
            }
          } finally {
            currentRun.attachmentCritical = false;
          }
        });
        reservations.delete(key);
        await run.promise;
        if (failed || !result) throw new Error('Verified recording recovery attachment failed.');
        return result;
      } finally {
        reservations.delete(key);
      }
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
                publicFailureMessage: 'Recording cleanup failed.',
                privateFailureCategory: 'cap',
              };
              try {
                await stopOnce(terminalRun, stored);
              } catch (error) {
                await preservePrivateFailure(terminalRun, error, 'cap');
              }
            }
            if (stored.driverSessionId)
              await deps.desktop.revoke(stored.id, stored.driverSessionId).catch(() => undefined);
            continue;
          }
          if (stored.state === 'exporting' || stored.state === 'attaching') {
            const recoverable = stored.state === 'exporting'
              ? Boolean(stored.projectValidated && stored.capProjectPath)
              : Boolean(stored.exportVerified && stored.exportPath);
            if (!recoverable) {
              await transitionAgentRecordingSession(
                project.path, stored.projectId, stored.sceneId, stored.id, 'failed',
                { phase: 'failed', message: stored.state === 'exporting'
                    ? 'Interrupted project validation cannot be retried.'
                    : 'Interrupted attachment has no verified export to retry.' },
              );
              if (stored.driverSessionId) await deps.desktop.revoke(stored.id, stored.driverSessionId).catch(() => undefined);
              continue;
            }
            await updateAgentRecordingSessionInternal(
              project.path,
              stored.projectId,
              stored.sceneId,
              stored.id,
              {
                retryAvailable:
                  stored.state === 'exporting' && stored.projectValidated && stored.capProjectPath
                    ? 'export'
                    : stored.state === 'attaching' && stored.exportVerified && stored.exportPath
                      ? 'attachment'
                      : undefined,
                phase: `${stored.state}-interrupted`,
                message:
                  stored.state === 'exporting'
                    ? stored.projectValidated && stored.capProjectPath
                      ? 'Export was interrupted. Retry is available only for the verified Cap project.'
                      : 'Export was interrupted, but no verified Cap project is available to retry.'
                    : stored.exportVerified && stored.exportPath
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
            publicFailureMessage: 'Recording workflow was interrupted by server restart.',
            privateFailureCategory: 'local',
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
