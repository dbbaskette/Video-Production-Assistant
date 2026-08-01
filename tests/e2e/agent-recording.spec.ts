import { expect, test, type Page, type Route } from '@playwright/test';

const projectId = 'dd2553cb-8967-4a4e-a1a2-6d9bcedca00f';
const sceneId = 'scene-01';
const sessionId = '2f45ebb7-4403-441b-ad97-4d6fa5640808';
const now = '2026-07-31T17:00:00.000Z';
const planFingerprint = 'sha256:reviewed-meeting-notes-settings';

const reviewedCapture = {
  targetApplication: 'MeetingNotes',
  startingUrl: '',
  targetKind: 'window' as const,
  width: 1920,
  height: 1080,
  fps: 30,
  cursor: true,
  microphone: false,
  camera: false,
  systemAudio: false,
};

const reviewedSteps = [
  { index: 0, action: 'Open General settings' },
  { index: 1, action: 'Switch to Model settings' },
  { index: 2, action: 'Switch to Integration settings' },
];

const plan = {
  version: 1 as const,
  projectId,
  projectName: 'meeting-notes-demo',
  projectObjective: 'Show the MeetingNotes settings workflow.',
  sceneId,
  sceneName: 'Settings tour',
  sceneType: 'desktop' as const,
  sceneIntent: 'Switch through the three settings sections.',
  sourceFingerprint: planFingerprint,
  stale: false,
  capture: reviewedCapture,
  steps: reviewedSteps,
  preconditions: ['MeetingNotes is open to Settings.', 'Demo data contains no private content.'],
  checkpoints: ['General, Model, and Integration are each visible.'],
  rehearseFirst: true as const,
  leadInSec: 2,
  tailSec: 2,
  failurePolicy: 'stop-and-do-not-attach' as const,
  attachmentEndpoint: `/api/projects/${projectId}/scenes/${sceneId}/recording`,
  updatedAt: now,
};

const rehearsal = {
  success: true,
  targetApplication: 'MeetingNotes',
  windowTitle: 'MeetingNotes — Settings',
  windowBounds: { x: 80, y: 40, width: 1512, height: 982 },
  completedStepIndexes: [0, 1, 2],
  checkpoints: [
    {
      description: 'General, Model, and Integration are each visible.',
      passed: true,
      detail: 'All three settings sections matched the reviewed fixture.',
    },
  ],
  resetConfirmed: true,
  diagnostic: 'Rehearsal completed and the General tab was restored.',
  reviewedCapture,
  reviewedSteps,
};

type SessionState =
  | 'rehearsing'
  | 'awaiting_confirmation'
  | 'recording'
  | 'exporting'
  | 'attaching'
  | 'completed'
  | 'failed'
  | 'interrupted';

function session(state: SessionState, patch: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    projectId,
    sceneId,
    state,
    createdAt: now,
    updatedAt: now,
    planFingerprint,
    ...patch,
  };
}

const storyboard = {
  schema_version: 1 as const,
  project: {
    id: projectId,
    name: 'meeting-notes-demo',
    created: now,
    objective: 'Show the MeetingNotes settings workflow.',
  },
  scenes: [
    {
      id: sceneId,
      name: 'Settings tour',
      description: 'Switch through General, Model, and Integration.',
      intent: 'Show the settings navigation.',
      type: 'desktop' as const,
      shot_plan: reviewedSteps,
    },
  ],
};

const readyCap = {
  state: 'ready' as const,
  installed: true,
  cliPath: '/fake/vpa-home/bin/cap',
  version: '0.3.99-test',
  captureReady: true,
  missingPermissions: [],
  targetCount: 1,
  message: 'Fake Cap is ready.',
  updatedAt: now,
};

const missingCap = {
  state: 'not-installed' as const,
  installed: false,
  captureReady: false,
  missingPermissions: [],
  targetCount: 0,
  message: 'Cap is not installed in this fake.',
  updatedAt: now,
};

interface FakeState {
  cap: Record<string, unknown>;
  currentSession: ReturnType<typeof session> | null;
  plan: typeof plan;
  requests: Array<{ method: string; path: string; body: unknown }>;
  unhandledRequests: string[];
}

async function installFakeApi(
  page: Page,
  initial: Partial<Pick<FakeState, 'cap' | 'currentSession' | 'plan'>> = {},
): Promise<FakeState> {
  const state: FakeState = {
    cap: initial.cap ?? readyCap,
    currentSession: initial.currentSession ?? null,
    plan: initial.plan ?? plan,
    requests: [],
    unhandledRequests: [],
  };

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          const target = window as typeof window & { __clipboardWrites?: string[] };
          target.__clipboardWrites = [...(target.__clipboardWrites ?? []), value];
        },
      },
    });
  });

  await page.route('**/api/**', async (route) => handleApiRoute(route, state));
  return state;
}

async function handleApiRoute(route: Route, state: FakeState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  const body = request.postDataJSON?.() ?? null;
  state.requests.push({ method, path, body });

  const fulfill = (json: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });

  if (path === '/api/projects')
    return fulfill({
      projects: [
        { id: projectId, name: 'meeting-notes-demo', path: '/fake/project', lastOpened: now },
      ],
    });
  if (path === `/api/projects/${projectId}`)
    return fulfill({
      id: projectId,
      name: 'meeting-notes-demo',
      path: '/fake/project',
      created: now,
      objective: 'Show the MeetingNotes settings workflow.',
      brand: null,
    });
  if (path === '/api/brands') return fulfill({ default_brand_id: null, brands: [] });
  if (path === `/api/projects/${projectId}/storyboard`) return fulfill(storyboard);
  if (path === `/api/projects/${projectId}/workflow-status`) return fulfill(workflowStatus());
  if (path === '/api/jobs') return fulfill({ jobs: [] });
  if (path === '/api/frames') return fulfill([]);
  if (path === '/api/settings/models/active')
    return fulfill({
      id: 'codex-cli',
      name: 'Codex CLI',
      provider: 'codex-cli',
      model: 'default',
      label: 'Codex CLI',
    });
  if (path === '/api/tts/engines') return fulfill([]);
  if (path === '/api/voices') return fulfill([]);
  if (path === `/api/projects/${projectId}/scenes/${sceneId}/script`)
    return fulfill({ sceneId, script: null, hasRecording: false });
  if (path === `/api/projects/${projectId}/scenes/${sceneId}/narration`)
    return fulfill({
      sceneId,
      hasScript: false,
      hasAudio: false,
      audio: null,
      subtitles: null,
      tts: null,
      timingCount: 0,
      chunks: [],
      mode: 'monologue',
      speakers: {},
      monologueScript: null,
      dialogScript: null,
      dialogDirty: false,
      hasPreviousMonologue: false,
      hasPreviousDialog: false,
    });
  if (path === `/api/projects/${projectId}/scenes/${sceneId}/lower-thirds`)
    return fulfill({ sceneId, lowerThirds: [] });
  if (path === `/api/projects/${projectId}/scenes/${sceneId}/shot-plan`)
    return fulfill({ transcript: [], proposedSteps: [], savedPlan: reviewedSteps });
  if (path === '/api/setup/cap' && method === 'GET') return fulfill(state.cap);
  if (path === '/api/setup/cap/install' && method === 'POST')
    return fulfill({ installationId: '0f85960d-158b-4283-b2e4-a42181693887', state: 'installing' });
  if (
    path === `/api/projects/${projectId}/scenes/${sceneId}/agent-recording/plan` &&
    method === 'GET'
  )
    return fulfill(state.plan);
  if (
    path === `/api/projects/${projectId}/scenes/${sceneId}/agent-recording/sessions/current` &&
    method === 'GET'
  )
    return fulfill(state.currentSession);
  if (
    path === `/api/projects/${projectId}/scenes/${sceneId}/agent-recording/rehearse` &&
    method === 'POST'
  ) {
    state.currentSession = session('rehearsing', {
      phase: 'rehearsing',
      message: 'Codex is operating the fake target.',
    });
    return fulfill(state.currentSession);
  }
  if (
    path ===
      `/api/projects/${projectId}/scenes/${sceneId}/agent-recording/sessions/${sessionId}/confirm` &&
    method === 'POST'
  ) {
    state.currentSession = session('recording', {
      phase: 'recording',
      confirmedCapture: true,
      message: 'The fake take is recording.',
    });
    return fulfill(state.currentSession);
  }
  if (
    path ===
      `/api/projects/${projectId}/scenes/${sceneId}/agent-recording/sessions/${sessionId}/cancel` &&
    method === 'POST'
  ) {
    state.currentSession = session('interrupted', {
      message: 'The fake take was cancelled safely.',
    });
    return fulfill(state.currentSession);
  }

  state.unhandledRequests.push(`${method} ${request.url()}`);
  return route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: `Unhandled fake route: ${method} ${path}` }),
  });
}

function workflowStatus() {
  const keys = [
    'storyboard',
    'recordings',
    'script',
    'narration',
    'lower-thirds',
    'render',
    'review',
  ] as const;
  return {
    projectId,
    computedAt: now,
    steps: keys.map((key) => ({
      key,
      label: key,
      state: key === 'storyboard' ? 'complete' : 'ready',
      summary: key,
      completed: key === 'storyboard' ? 1 : 0,
      total: 1,
    })),
    nextAction: {
      key: 'open_scene_recording',
      label: 'Record scene',
      summary: 'Capture the scene.',
      sceneId,
    },
    issues: [],
    counts: { blockers: 0, warnings: 0 },
    progress: { completed: 1, total: 7, percent: 14 },
    render: {
      ready: false,
      readyScenes: 0,
      totalScenes: 1,
      blockers: [],
      warnings: [],
      output: { state: 'missing' },
    },
  };
}

async function openRecordingDialog(page: Page): Promise<void> {
  await page.goto(`/project/${projectId}/storyboard?scene=${sceneId}`);
  await expect(page.getByRole('button', { name: 'Set up recording' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up recording' }).click();
  await expect(page.getByRole('heading', { name: 'Capture this scene' })).toBeVisible();
}

function matchingRequests(state: FakeState, method: string, suffix: string) {
  return state.requests.filter(
    (request) => request.method === method && request.path.endsWith(suffix),
  );
}

function expectNoUnhandledRequests(state: FakeState) {
  expect(state.unhandledRequests, 'Every local API request must have an explicit fake').toEqual([]);
}

test('installs Cap, dispatches rehearsal directly, confirms once, and follows the local take lifecycle', async ({
  page,
}) => {
  const fake = await installFakeApi(page, { cap: missingCap });
  await openRecordingDialog(page);
  const dialog = page.getByRole('dialog', { name: 'Capture this scene' });

  await expect(page.getByText('Cap is not installed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Install Cap', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: 'Install Cap Desktop?' })).toBeVisible();
  await page.getByRole('button', { name: 'Download and install Cap' }).click();
  await expect(page.getByText('Installing Cap', { exact: true })).toBeVisible();
  expect(matchingRequests(fake, 'POST', '/api/setup/cap/install')).toHaveLength(1);
  expect(matchingRequests(fake, 'POST', '/api/setup/cap/install')[0]?.body).toEqual({
    confirmed: true,
  });

  fake.cap = readyCap;
  await expect(page.getByText('Cap 0.3.99-test is ready')).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Save & rehearse with Codex' }).click();
  await expect(page.getByText('Codex is rehearsing', { exact: true }).first()).toBeVisible();
  expect(matchingRequests(fake, 'POST', '/agent-recording/rehearse')).toHaveLength(1);
  expect(
    await page.evaluate(
      () => (window as typeof window & { __clipboardWrites?: string[] }).__clipboardWrites ?? [],
    ),
  ).toEqual([]);

  fake.currentSession = session('awaiting_confirmation', {
    rehearsal,
    message: 'The fake rehearsal is ready for review.',
  });
  await expect(
    page.getByRole('heading', { name: 'Ready for your recording confirmation' }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    dialog
      .getByText('Verified application')
      .locator('..')
      .getByText('MeetingNotes', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog
      .getByText('Verified window')
      .locator('..')
      .getByText('MeetingNotes — Settings', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('1512 × 982 at 80, 40', { exact: true })).toBeVisible();
  await expect(dialog.getByText('1920 × 1080 · 30 fps', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Cursor on', { exact: true })).toHaveClass(/is-on/);
  await expect(dialog.getByText('Microphone off', { exact: true })).not.toHaveClass(/is-on/);
  await expect(dialog.getByText('Camera off', { exact: true })).not.toHaveClass(/is-on/);
  await expect(dialog.getByText('System Audio off', { exact: true })).not.toHaveClass(/is-on/);
  for (const step of reviewedSteps) {
    await expect(dialog.locator('li.is-passed', { hasText: step.action })).toBeVisible();
  }
  await expect(
    dialog.locator('li.is-passed', {
      hasText: 'General, Model, and Integration are each visible.',
    }),
  ).toContainText('All three settings sections matched the reviewed fixture.');
  await expect(dialog.getByText('Target reset verified', { exact: true })).toHaveClass(/is-passed/);
  await expect(
    dialog.getByText('Rehearsal completed and the General tab was restored.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Capture is still off. Recording begins only after you confirm this exact rehearsal.',
    ),
  ).toBeVisible();
  expect(matchingRequests(fake, 'POST', '/confirm')).toHaveLength(0);

  await page.getByRole('button', { name: 'Confirm & record' }).click();
  await expect(
    page.getByText('Recording this scene with Cap', { exact: true }).first(),
  ).toBeVisible();
  const confirmRequests = matchingRequests(fake, 'POST', '/confirm');
  expect(confirmRequests).toHaveLength(1);
  expect(confirmRequests[0]?.body).toEqual({ confirmed: true, planFingerprint });

  fake.currentSession = session('exporting', { confirmedCapture: true, phase: 'exporting' });
  await expect(dialog.getByText('Validating and exporting the take', { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  fake.currentSession = session('attaching', { confirmedCapture: true, phase: 'attaching' });
  await expect(dialog.getByText('Attaching the recording', { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  fake.currentSession = session('completed', {
    confirmedCapture: true,
    message: 'The fake recording is attached.',
  });
  await expect(page.getByRole('heading', { name: 'Capture this scene' })).toBeHidden({
    timeout: 5_000,
  });
  expectNoUnhandledRequests(fake);
});

test('shows stale-plan and rehearsal-failure diagnostics with manual upload available', async ({
  page,
}) => {
  const failed = session('failed', {
    message: 'Rehearsal failed: the Integration tab did not match the reviewed checkpoint.',
  });
  const fake = await installFakeApi(page, {
    plan: { ...plan, stale: true },
    currentSession: failed,
  });
  await openRecordingDialog(page);
  const dialog = page.getByRole('dialog', { name: 'Capture this scene' });

  await expect(
    dialog.getByText(
      'The scene changed after this plan was saved. Review it before rehearsing again.',
    ),
  ).toBeVisible();
  await expect(dialog.getByText('Recording stopped')).toBeVisible();
  await expect(
    dialog.getByText(
      'Rehearsal failed: the Integration tab did not match the reviewed checkpoint.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Upload manually', exact: true })).toBeEnabled();
  expectNoUnhandledRequests(fake);
});

test('cancels an awaiting take without confirming and restores the manual-upload fallback', async ({
  page,
}) => {
  const fake = await installFakeApi(page, {
    currentSession: session('awaiting_confirmation', { rehearsal }),
  });
  await openRecordingDialog(page);
  const dialog = page.getByRole('dialog', { name: 'Capture this scene' });

  expect(matchingRequests(fake, 'POST', '/confirm')).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByText('The fake take was cancelled safely.')).toBeVisible();
  expect(matchingRequests(fake, 'POST', '/cancel')).toHaveLength(1);
  expect(matchingRequests(fake, 'POST', '/confirm')).toHaveLength(0);
  await expect(dialog.getByRole('button', { name: 'Upload manually', exact: true })).toBeEnabled();
  expectNoUnhandledRequests(fake);
});
