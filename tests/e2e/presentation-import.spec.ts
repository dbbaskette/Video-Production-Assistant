import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { rm } from 'node:fs/promises';

const API = 'http://localhost:3000';
const E2E_HOME = '/tmp/vpa-e2e-home';
const E2E_PROJECTS = '/tmp/vpa-e2e-projects';

type StoryboardResponse = {
  scenes: Array<{
    id: string;
    name: string;
    type: string;
    presentation_source?: { presentation_id: string; page_number: number; page_count: number };
  }>;
};

type PresentationJobResponse = {
  id: string;
  project_id: string;
  filename: string;
  status: 'processing' | 'ready' | 'partial' | 'failed';
  stage: 'uploading' | 'processing-slides' | 'creating-scenes' | 'drafting-narration' | 'ready' | 'failed';
  generate_narration: boolean;
  page_count: number;
  processed_pages: number;
  analyzed_pages: number;
  scripted_pages: number;
  remaining_scene_count: number;
  deterministic_commit?: 'uncommitted' | 'commit-pending' | 'committed';
  created_at: string;
  updated_at: string;
  error?: { code: string; message: string };
  schema_version: 1;
};

test.describe.serial('presentation import', () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    await rm(E2E_HOME, { recursive: true, force: true });
    await rm(E2E_PROJECTS, { recursive: true, force: true });
  });

  test('imports, reorders, reloads, and removes a real three-page PDF without model calls', async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const modelMutations: string[] = [];
    const handledStoryboardNotFound: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (request) => failedRequests.push(request.url()));
    page.on('response', (response) => {
      if (
        response.status() === 404
        && /^\/api\/projects\/[^/]+\/storyboard$/.test(new URL(response.url()).pathname)
      ) handledStoryboardNotFound.push(response.url());
    });
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        request.method() !== 'GET'
        && /\/(analyze|script\/generate|narration\/(generate|generate-all)|retry-narration)$/.test(pathname)
      ) {
        modelMutations.push(`${request.method()} ${pathname}`);
      }
    });

    const pdf = await threePagePdf();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'I have a presentation' })).toBeVisible();
    await page.getByRole('button', { name: 'I have a presentation' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a narrated presentation' });
    await dialog.getByPlaceholder('MCP Demo Test').fill('presentation-e2e');
    await dialog.getByLabel('Presentation PDF').setInputFiles({
      name: 'architecture-brief.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(pdf),
    });
    await expect(dialog.getByText(/3 slides/)).toBeVisible();
    const narration = dialog.getByRole('checkbox', { name: 'Generate draft narration' });
    await expect(narration).toBeChecked();
    await narration.uncheck();
    await captureAtWidths(page, testInfo, 'dashboard-picker');

    await dialog.getByRole('button', { name: 'Create & import presentation' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/project\/[^/]+\/storyboard/);
    const projectId = projectIdFromUrl(page.url());
    await expect(page.locator('.storyboard-presentation-owner')).toContainText(
      /Processing slides|Creating scenes|Presentation ready/,
    );
    await captureAtWidths(page, testInfo, 'storyboard-progress');

    const sceneButtons = page.getByRole('button', { name: /^Select scene / });
    await expect(sceneButtons).toHaveCount(3, { timeout: 60_000 });
    await expect(sceneButtons.nth(0)).toHaveAccessibleName('Select scene Opening');
    await expect(sceneButtons.nth(1)).toHaveAccessibleName('Select scene Architecture');
    await expect(sceneButtons.nth(2)).toHaveAccessibleName('Select scene Next steps');
    await expect(page.getByText('Presentation ready', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('3 scenes remain', { exact: true })).toBeVisible();
    await captureAtWidths(page, testInfo, 'presentations-management');

    const initial = await storyboard(page, projectId);
    expect(initial.scenes.map(({ name }) => name)).toEqual(['Opening', 'Architecture', 'Next steps']);
    expect(initial.scenes.map(({ type }) => type)).toEqual(['slide', 'slide', 'slide']);
    expect(initial.scenes.map((scene) => scene.presentation_source?.page_number)).toEqual([1, 2, 3]);
    const presentationId = initial.scenes[0]!.presentation_source!.presentation_id;
    expect(initial.scenes.every((scene) => scene.presentation_source?.presentation_id === presentationId)).toBe(true);

    await page.getByRole('button', { name: 'Move down' }).first().click();
    await expect.poll(async () => (await storyboard(page, projectId)).scenes.map(({ name }) => name))
      .toEqual(['Architecture', 'Opening', 'Next steps']);
    const reordered = await storyboard(page, projectId);
    expect(reordered.scenes.map((scene) => scene.presentation_source?.page_number)).toEqual([2, 1, 3]);

    await page.reload();
    await expect(page.getByRole('button', { name: /^Select scene / })).toHaveCount(3);
    await expect(page.getByText('Presentation ready', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Select scene Opening' }).click();
    await expect(page.getByText('5s hold without narration', { exact: true })).toBeVisible();
    await expect(page.getByText('1s', { exact: true })).toHaveCount(0);

    const jobsResponse = await page.request.get(`${API}/api/projects/${projectId}/presentations`);
    expect(jobsResponse.ok()).toBe(true);
    const jobs = await jobsResponse.json() as { presentations: PresentationJobResponse[] };
    expect(jobs.presentations).toHaveLength(1);
    expect(jobs.presentations[0]).toMatchObject({
      id: presentationId,
      status: 'ready',
      generate_narration: false,
      analyzed_pages: 0,
      scripted_pages: 0,
      remaining_scene_count: 3,
    });

    const unrelatedResponse = await page.request.post(
      `${API}/api/projects/${projectId}/storyboard/scenes`,
      { data: { name: 'Unrelated scene', description: 'Keep this scene.', type: 'browser' } },
    );
    expect(unrelatedResponse.ok()).toBe(true);
    await page.goto(`/project/${projectId}/storyboard?scene=${initial.scenes[0]!.id}&tab=Script&safe=1`);
    await expect(page.getByRole('button', { name: 'Select scene Opening' })).toBeVisible();
    const openingRow = page.getByRole('button', { name: 'Select scene Opening' }).locator('..');
    await openingRow.getByRole('button', { name: 'Remove' }).click();
    const sceneConfirm = page.getByRole('dialog', { name: /Remove "Opening"/ });
    await sceneConfirm.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('2 scenes remain', { exact: true })).toBeVisible();
    await expect(page.getByText('architecture-brief.pdf', { exact: true })).toBeVisible();

    let deckDeleteRequests = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'DELETE'
        && request.url() === `${API}/api/projects/${projectId}/presentations/${presentationId}?confirmed=true`
      ) deckDeleteRequests += 1;
    });
    await page.getByRole('button', { name: 'Remove imported deck', exact: true }).click();
    const deckConfirm = page.getByRole('dialog', { name: 'Remove imported deck?' });
    await expect(deckConfirm).toContainText('2 remaining scenes will be deleted.');
    await deckConfirm.getByRole('button', { name: 'Remove imported deck', exact: true })
      .evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });

    await expect(page.getByRole('button', { name: 'Select scene Unrelated scene' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Select scene / })).toHaveCount(1);
    await expect(page.getByText('No presentation imports yet.', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/scene=.*&tab=Script&safe=1/);
    expect(deckDeleteRequests).toBe(1);
    const afterRemoval = await storyboard(page, projectId);
    expect(afterRemoval.scenes.map(({ name }) => name)).toEqual(['Unrelated scene']);
    expect(afterRemoval.scenes[0]!.presentation_source).toBeUndefined();

    expect(modelMutations).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    // A newly created project has no storyboard until the atomic deck commit.
    // The client handles that exact 404 as its empty state; Chromium still emits
    // one generic network console line for it. No other console error is allowed.
    expect(handledStoryboardNotFound).toHaveLength(1);
    expect(consoleErrors.filter((message) => (
      message !== 'Failed to load resource: the server responded with a status of 404 (Not Found)'
    ))).toEqual([]);
    expect(consoleErrors).toHaveLength(handledStoryboardNotFound.length);
  });

  test('isolates exact failed-job retry routes and leaves unrelated API traffic real', async ({ page }) => {
    await page.goto('/');
    const projectsResponse = await page.request.get(`${API}/api/projects`);
    const projects = await projectsResponse.json() as { projects: Array<{ id: string; name: string }> };
    const project = projects.projects.find(({ name }) => name === 'presentation-e2e');
    expect(project).toBeTruthy();
    const projectId = project!.id;
    const presentationId = '55555555-5555-4555-8555-555555555555';
    const now = '2026-08-05T12:00:00.000Z';
    const failedJob: PresentationJobResponse = {
      schema_version: 1,
      id: presentationId,
      project_id: projectId,
      filename: 'retryable.pdf',
      status: 'failed',
      stage: 'failed',
      generate_narration: false,
      page_count: 3,
      processed_pages: 0,
      analyzed_pages: 0,
      scripted_pages: 0,
      remaining_scene_count: 0,
      deterministic_commit: 'uncommitted',
      created_at: now,
      updated_at: now,
      error: { code: 'processing_failed', message: 'untrusted internal diagnostic marker' },
    };
    const retryingJob: PresentationJobResponse = {
      ...failedJob,
      status: 'processing',
      stage: 'processing-slides',
      updated_at: '2026-08-05T12:00:01.000Z',
      error: undefined,
    };
    const listUrl = `${API}/api/projects/${projectId}/presentations`;
    const retryUrl = `${API}/api/projects/${projectId}/presentations/${presentationId}/retry-import`;
    let listRequests = 0;
    let retryRequests = 0;
    let realStoryboardRequests = 0;
    page.on('request', (request) => {
      if (request.url() === `${API}/api/projects/${projectId}/storyboard`) realStoryboardRequests += 1;
    });
    await page.route(listUrl, async (route) => {
      listRequests += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ presentations: [failedJob] }) });
    });
    await page.route(retryUrl, async (route) => {
      retryRequests += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(retryingJob) });
    });

    await page.goto(`/project/${projectId}/storyboard?tab=Script&safe=1`);
    await expect(page.getByText('The presentation could not be processed; try the import again', { exact: true })).toBeVisible();
    await expect(page.getByText('untrusted internal diagnostic marker')).toHaveCount(0);
    const retry = page.getByRole('button', { name: 'Retry import', exact: true });
    await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(page.getByText('Processing slides', { exact: true })).toBeVisible();
    expect(retryRequests).toBe(1);
    expect(listRequests).toBeGreaterThanOrEqual(1);
    expect(realStoryboardRequests).toBeGreaterThanOrEqual(1);
    await expect(page).toHaveURL(/tab=Script&safe=1/);
  });
});

async function threePagePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const heading = await document.embedFont(StandardFonts.HelveticaBold);
  const body = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, title] of ['Opening', 'Architecture', 'Next steps'].entries()) {
    const page = document.addPage([1280, 720]);
    page.drawRectangle({ x: 0, y: 0, width: 1280, height: 720, color: rgb(0.04, 0.05, 0.08) });
    page.drawText(title, { x: 86, y: 560, size: 58, font: heading, color: rgb(0.94, 0.95, 0.98) });
    page.drawText(`Deterministic slide ${index + 1}`, {
      x: 88,
      y: 490,
      size: 24,
      font: body,
      color: rgb(0.56, 0.6, 0.7),
    });
  }
  return document.save();
}

async function storyboard(page: Page, projectId: string): Promise<StoryboardResponse> {
  const response = await page.request.get(`${API}/api/projects/${projectId}/storyboard`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<StoryboardResponse>;
}

function projectIdFromUrl(value: string): string {
  const match = /\/project\/([^/]+)\/storyboard/.exec(new URL(value).pathname);
  if (!match) throw new Error(`Storyboard project id missing from ${value}`);
  return match[1]!;
}

async function captureAtWidths(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`${label}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
