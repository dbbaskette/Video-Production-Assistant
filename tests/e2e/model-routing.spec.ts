import { expect, test, type Page } from '@playwright/test';
import {
  MODEL_IDS,
  armNextVideoAnalysisFailure,
  clearModelRoutingE2eCalls,
  readModelRoutingE2eCalls,
} from './fixtures/model-routing-fixture.js';

const API_BASE = 'http://127.0.0.1:3100';
const PRESERVED_SCRIPT = 'Existing authored script that must survive every clean routing failure.';

type Role = 'video-understanding' | 'writing' | 'general';

let projectId = '';

async function json<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${API_BASE}${path}`);
  expect(response.ok(), `${path} should return a successful response`).toBe(true);
  return response.json() as Promise<T>;
}

async function waitForAssignment(
  page: Page,
  path: string,
  role: Role,
  expected: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await json<{ assignments: Partial<Record<Role, string>> }>(page, path);
      return response.assignments[role] ?? null;
    })
    .toBe(expected);
}

async function selectGlobal(page: Page, role: Role, modelId: string | null): Promise<void> {
  const select = page.locator(`#global-${role}`);
  await expect(select).toBeVisible();
  await select.selectOption(modelId ?? '');
  await waitForAssignment(page, '/api/settings/model-routing', role, modelId);
  await expect(select).toBeEnabled();
}

async function selectProject(page: Page, role: Role, modelId: string | null): Promise<void> {
  const select = page.locator(`#project-${role}`);
  await expect(select).toBeVisible();
  await select.selectOption(modelId ?? '');
  await waitForAssignment(page, `/api/projects/${projectId}/model-routing`, role, modelId);
  await expect(select).toBeEnabled();
}

async function openProjectOverview(page: Page): Promise<void> {
  await page.goto(`/project/${projectId}#project-ai-models-title`);
  await expect(page.getByRole('heading', { name: 'AI models' })).toBeVisible();
}

async function openSceneTab(
  page: Page,
  tab: 'Recording' | 'Script' | 'Lower Thirds',
): Promise<void> {
  await page.goto(`/project/${projectId}/storyboard?scene=scene-01`);
  await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
  await page.getByRole('button', { name: tab, exact: true }).click();
}

async function createStoryboardProject(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Ideate a new demo' })).toBeVisible();
  await dialog.getByPlaceholder('MCP Demo Test').fill('model-routing-e2e');
  await dialog.getByRole('button', { name: 'Create & start ideating' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/ideation$/);

  const match = /\/project\/([^/]+)\/ideation$/.exec(new URL(page.url()).pathname);
  expect(match?.[1]).toBeTruthy();
  const id = match![1]!;

  await page
    .getByPlaceholder('Describe what you want to demo…')
    .fill('Show how task-based model routing keeps video analysis separate from writing.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Proposed Scenes').first()).toBeVisible();
  await page.getByRole('button', { name: 'Accept & Create Storyboard' }).click();
  await expect(page).toHaveURL(new RegExp(`/project/${id}/storyboard`));
  return id;
}

async function expectPreservedScene(page: Page): Promise<void> {
  await openSceneTab(page, 'Recording');
  await expect(page.getByText('recordings/scene-01.mp4')).toBeVisible();
  await page.getByRole('button', { name: 'Script', exact: true }).click();
  await expect(page.getByPlaceholder('Monologue script…')).toHaveValue(PRESERVED_SCRIPT);
}

test.describe.serial('task-based model routing', () => {
  test('routes one grounded workflow through fake video and writing specialists', async ({
    page,
  }) => {
    await page.goto('/settings#model-assignments');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    await selectGlobal(page, 'video-understanding', MODEL_IDS.primaryVideo);
    await selectGlobal(page, 'writing', MODEL_IDS.writer);
    await selectGlobal(page, 'general', MODEL_IDS.projectWriter);

    const videoOptions = await page
      .locator('#global-video-understanding option')
      .evaluateAll((options) =>
        options.map((option) => ({
          value: (option as HTMLOptionElement).value,
          text: option.textContent,
        })),
      );
    expect(videoOptions.some((option) => option.value === MODEL_IDS.writer)).toBe(false);
    expect(videoOptions.some((option) => option.value === MODEL_IDS.projectWriter)).toBe(false);

    projectId = await createStoryboardProject(page);
    await openProjectOverview(page);
    await selectProject(page, 'writing', MODEL_IDS.projectWriter);
    await expect(page.locator('#project-video-understanding')).toHaveValue('');
    await expect(page.locator('#project-general')).toHaveValue('');

    await clearModelRoutingE2eCalls();
    await openSceneTab(page, 'Recording');
    await page.locator('input[type="file"][accept*="video"]').setInputFiles({
      name: 'routing-demo.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('deterministic fake video bytes'),
    });
    await expect(page.getByText('recordings/scene-01.mp4')).toBeVisible();

    let calls = await readModelRoutingE2eCalls();
    expect(calls.filter((call) => call.kind === 'video.upload')).toHaveLength(1);
    expect(calls.find((call) => call.kind === 'video.upload')?.inputPath).toMatch(
      /model-routing-e2e\/recordings\/scene-01\.mp4$/,
    );

    const reanalysisUrl = `**/api/projects/${projectId}/scenes/scene-01/analyze`;
    await page.route(reanalysisUrl, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.continue();
    });
    const callsBeforeReanalysis = calls;
    await page.getByRole('button', { name: 'Re-analyze scene' }).click();
    const reanalysisDialog = page.getByRole('dialog', { name: 'Re-analyzing scene' });
    await expect(reanalysisDialog).toContainText(
      'Gemini Vision Primary analyzes the recording → VPA prepares the preview…',
    );
    await expect(reanalysisDialog).not.toContainText('Claude Analyst');
    await expect(reanalysisDialog).not.toContainText('Codex Writer');
    await expect(reanalysisDialog).toBeHidden();
    await page.unroute(reanalysisUrl);
    await expect(page.getByText('Proposed update')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    calls = await readModelRoutingE2eCalls();
    expect(calls.filter((call) => call.kind === 'video.upload')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'text.complete')).toEqual(
      callsBeforeReanalysis.filter((call) => call.kind === 'text.complete'),
    );

    await page.getByRole('button', { name: 'Script', exact: true }).click();
    await expect(
      page.getByText(
        'Gemini Vision Primary watches the recording; Claude Analyst (fake) writes the script.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Generate script' }).click();
    await expect(page.getByPlaceholder('Monologue script…')).not.toHaveValue('');
    await expect(page.getByText('Reusing the current Gemini timing brief.')).toBeVisible();

    calls = await readModelRoutingE2eCalls();
    expect(calls.filter((call) => call.kind === 'video.upload')).toHaveLength(1);
    const groundedScriptCall = calls.find(
      (call) =>
        call.kind === 'text.complete' &&
        call.entryId === MODEL_IDS.projectWriter &&
        call.systemPrompt?.toLowerCase().includes('narration script writer'),
    );
    expect(groundedScriptCall?.userPrompt).toContain('Ordered segment index');
    expect(groundedScriptCall?.userPrompt).not.toContain('recordings/scene-01.mp4');
    expect(groundedScriptCall?.userPrompt).not.toContain('generativelanguage.googleapis.com');

    await page.getByRole('button', { name: 'Lower Thirds', exact: true }).click();
    await expect(
      page.getByText(
        'Gemini Vision Primary watches the recording; Claude Analyst (fake) writes the lower-third copy.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Recommend Lower Thirds' }).click();
    await expect(page.getByText('Lower third 1')).toBeVisible();
    await expect(page.getByText('Reusing the current Gemini timing brief.')).toBeVisible();

    calls = await readModelRoutingE2eCalls();
    expect(calls.filter((call) => call.kind === 'video.upload')).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.kind === 'text.complete' &&
          call.entryId === MODEL_IDS.projectWriter &&
          call.responseFormat === 'json' &&
          call.userPrompt?.includes('Candidate moments from the video analysis'),
      ),
    ).toBe(true);

    await openProjectOverview(page);
    await selectProject(page, 'video-understanding', MODEL_IDS.secondaryVideo);
    await openSceneTab(page, 'Script');
    await expect(
      page.getByText(
        'Gemini Vision Secondary watches the recording; Claude Analyst (fake) writes the script.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Regenerate' }).click();
    await expect(
      page.getByText('Gemini analyzed the recording and created a new timing brief.'),
    ).toBeVisible();

    calls = await readModelRoutingE2eCalls();
    expect(calls.filter((call) => call.kind === 'video.upload')).toHaveLength(2);
    expect(calls.filter((call) => call.kind === 'video.generate').at(-1)?.model).toBe(
      'gemini-e2e-secondary',
    );

    await openProjectOverview(page);
    await selectProject(page, 'writing', null);
    const writingRow = page.locator('.model-assignment-row').filter({
      has: page.locator('label[for="project-writing"]'),
    });
    await expect(writingRow).toContainText('Using global setting');
    await expect(writingRow).toContainText('Codex Writer (fake)');

    await openSceneTab(page, 'Script');
    await expect(
      page.getByText(
        'Gemini Vision Secondary watches the recording; Codex Writer (fake) writes the script.',
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Regenerate' }).click();
    await expect(page.getByText('Reusing the current Gemini timing brief.')).toBeVisible();

    calls = await readModelRoutingE2eCalls();
    expect(calls.filter((call) => call.kind === 'video.upload')).toHaveLength(2);
    expect(
      calls
        .filter(
          (call) =>
            call.kind === 'text.complete' &&
            call.systemPrompt?.toLowerCase().includes('narration script writer'),
        )
        .at(-1)?.entryId,
    ).toBe(MODEL_IDS.writer);

    const script = page.getByPlaceholder('Monologue script…');
    await script.fill(PRESERVED_SCRIPT);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Unsaved changes')).not.toBeVisible();
    await expect(script).toHaveValue(PRESERVED_SCRIPT);
  });

  test('fails cleanly for missing video, unavailable writing, and blocked deletion', async ({
    page,
  }) => {
    expect(
      projectId,
      'The primary staged workflow creates the shared project fixture',
    ).toBeTruthy();

    await openProjectOverview(page);
    await selectProject(page, 'video-understanding', null);
    await page.goto('/settings#model-assignments');
    await selectGlobal(page, 'video-understanding', null);

    const callsBeforeMissingVideo = await readModelRoutingE2eCalls();
    await openSceneTab(page, 'Script');
    const grounding = page.locator('.scene-grounding');
    await expect(grounding.getByRole('checkbox')).toBeDisabled();
    await expect(grounding).toContainText('No model is assigned to the video-understanding role.');
    await expect(page.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
    await expect(page.getByPlaceholder('Monologue script…')).toHaveValue(PRESERVED_SCRIPT);
    expect(await readModelRoutingE2eCalls()).toEqual(callsBeforeMissingVideo);

    await grounding.getByRole('link', { name: "Open this project's AI models" }).click();
    await expect(page).toHaveURL(new RegExp(`/project/${projectId}#project-ai-models-title$`));
    const videoRow = page.locator('.model-assignment-row').filter({
      has: page.locator('label[for="project-video-understanding"]'),
    });
    await videoRow.getByRole('link', { name: 'Fix the global setting' }).click();
    await expect(page).toHaveURL(/\/settings#model-assignments$/);
    await expect(page.locator('#global-video-understanding')).toBeVisible();

    await selectGlobal(page, 'video-understanding', MODEL_IDS.primaryVideo);
    await openProjectOverview(page);
    await selectProject(page, 'writing', MODEL_IDS.unavailableWriter);

    await expectPreservedScene(page);
    const callsBeforeWriterFailure = await readModelRoutingE2eCalls();
    await page.getByRole('button', { name: 'Regenerate' }).click();
    const failure = page.getByRole('alert').filter({ hasText: 'Generation failed:' });
    await expect(failure).toContainText(
      'The assigned model for writing is unavailable. Check its configuration in project model settings.',
    );
    await expect(page.getByPlaceholder('Monologue script…')).toHaveValue(PRESERVED_SCRIPT);
    expect(await readModelRoutingE2eCalls()).toEqual(callsBeforeWriterFailure);

    await failure.getByRole('link', { name: "Open this project's AI models" }).click();
    await expect(page).toHaveURL(new RegExp(`/project/${projectId}#project-ai-models-title$`));
    await expect(page.locator('#project-writing')).toHaveValue(MODEL_IDS.unavailableWriter);

    await page.goto('/settings#model-library');
    const unavailableCard = page
      .locator('.model-library-card')
      .filter({ hasText: 'Unavailable Writer' });
    await unavailableCard.getByRole('button', { name: 'Remove' }).click();
    const confirmation = page.getByRole('dialog', { name: 'Delete this model configuration?' });
    await confirmation.getByRole('button', { name: 'Delete' }).click();
    await expect(unavailableCard).toContainText('Reassign this model before deleting it.');
    await expect(unavailableCard).toContainText('model-routing-e2e: Write and refine content.');

    const models = await json<Array<{ id: string }>>(page, '/api/settings/models');
    expect(models.some((model) => model.id === MODEL_IDS.unavailableWriter)).toBe(true);
    await unavailableCard.getByRole('link', { name: 'Open project AI models' }).click();
    await expect(page).toHaveURL(new RegExp(`/project/${projectId}#project-ai-models-title$`));
    await expect(page.locator('#project-writing')).toHaveValue(MODEL_IDS.unavailableWriter);
    await expectPreservedScene(page);
  });

  test('keeps the replacement attached and authored script intact when video analysis fails', async ({
    page,
  }) => {
    expect(projectId, 'The primary staged workflow creates the shared project fixture').toBeTruthy();

    await clearModelRoutingE2eCalls();
    await armNextVideoAnalysisFailure();
    await openSceneTab(page, 'Recording');
    await page.getByRole('button', { name: 'Replace recording' }).click();

    const uploadResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/api/projects/${projectId}/scenes/scene-01/recording`),
    );
    await page.locator('input[type="file"][accept*="video"]').setInputFiles({
      name: 'routing-analysis-failure.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('replacement bytes that invalidate the existing timing brief'),
    });

    const response = await uploadResponse;
    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({
      sceneId: 'scene-01',
      relativePath: 'recordings/scene-01.mp4',
      analysis: {
        status: 'failed',
        code: 'video_analysis_failed',
        message: 'Video analysis failed. The recording is saved; try re-analyzing later.',
      },
    });

    const failure = page.getByRole('alert').filter({
      hasText: 'Recording saved; analysis needs attention.',
    });
    await expect(failure).toHaveAttribute('data-error-code', 'video_analysis_failed');
    await expect(failure).toContainText(
      'Video analysis failed. The recording is saved; try re-analyzing later.',
    );
    await expect(failure).not.toContainText('Deterministic E2E');
    await expect(page.getByText('recordings/scene-01.mp4')).toBeVisible();

    const calls = await readModelRoutingE2eCalls();
    expect(calls.filter((call) => call.kind === 'video.upload')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'video.wait')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'video.generate')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'video.failure')).toEqual([
      { kind: 'video.failure', model: 'gemini-e2e-primary' },
    ]);
    expect(calls.filter((call) => call.kind === 'video.delete')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'text.complete')).toHaveLength(0);

    await page.getByRole('button', { name: 'Re-analyze scene' }).click();
    await expect(page.getByText('Proposed update')).toBeVisible();
    await expect(failure).toBeHidden();
    await expect(page.getByText('recordings/scene-01.mp4')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Script', exact: true }).click();
    await expect(page.getByPlaceholder('Monologue script…')).toHaveValue(PRESERVED_SCRIPT);
  });
});
