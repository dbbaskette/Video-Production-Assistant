import { expect, test, type Page, type Route } from '@playwright/test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const project = {
  id: PROJECT_ID,
  name: '24 Scene UX Fixture',
  path: '/tmp/vpa-e2e-projects/24-scene-ux-fixture',
  created: '2026-08-06T12:00:00.000Z',
  lastOpened: '2026-08-06T16:00:00.000Z',
  brand: null,
  model_routing: {},
};
const scenes = Array.from({ length: 24 }, (_, index) => ({
  id: `scene-${String(index + 1).padStart(2, '0')}`,
  name: index === 1
    ? 'A deliberately long scene title that wraps cleanly on a narrow workspace'
    : `Workflow scene ${String(index + 1).padStart(2, '0')}`,
  description: index % 2 === 0 ? 'Review the product workflow in the browser.' : 'Explain the next action.',
  type: index % 4 === 0 ? 'desktop' : index % 4 === 1 ? 'browser' : index % 4 === 2 ? 'terminal' : 'slide',
  ...(index % 3 === 0 ? { recording: { source: `recordings/scene-${index + 1}.mp4` } } : {}),
  ...(index % 4 === 0 ? { narration: { script: `Narrate scene ${index + 1}.` } } : {}),
}));
const storyboard = {
  schema_version: 1,
  project: {
    id: PROJECT_ID,
    name: project.name,
    created: project.created,
    objective: 'Demonstrate efficient navigation across a substantial storyboard.',
  },
  scenes,
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installFixture(page: Page) {
  await page.route('http://localhost:3000/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      await json(route, { error: 'Fixture is read-only.' }, 405);
      return;
    }
    if (url.pathname === '/api/projects') {
      await json(route, { projects: [project] });
      return;
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}`) {
      await json(route, project);
      return;
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/storyboard`) {
      await json(route, storyboard);
      return;
    }
    if (url.pathname === '/api/brands') {
      await json(route, { brands: [], default_brand_id: null });
      return;
    }
    if (url.pathname.endsWith('/agent-recording/sessions/current')) {
      await json(route, null);
      return;
    }
    if (url.pathname.endsWith('/script')) {
      await json(route, { sceneId: 'fixture', script: null, hasRecording: false });
      return;
    }
    if (url.pathname === '/api/frames' || url.pathname === '/api/tts/engines' || url.pathname === '/api/voices') {
      await json(route, []);
      return;
    }
    if (url.pathname.endsWith('/narration')) {
      await json(route, { sceneId: 'fixture', mode: 'monologue', script: null, chunks: [] });
      return;
    }
    if (url.pathname.endsWith('/lower-thirds')) {
      await json(route, { sceneId: 'fixture', lowerThirds: [] });
      return;
    }
    await json(route, { error: 'Not available in this fixture.' }, 404);
  });
}

test('project discovery and a 24-scene storyboard remain fast, accessible, and responsive', async ({ page }) => {
  await installFixture(page);
  await page.goto('/');

  const projectCard = page.getByRole('link', { name: `Open ${project.name}` });
  await expect(projectCard).toBeVisible();
  await expect(projectCard.locator('.project-list-card__time')).toBeVisible();
  await expect(projectCard.locator('.project-list-card__time')).toContainText('Opened');
  await page.getByRole('searchbox', { name: 'Search recent projects' }).fill('24 scene');
  await expect(page.getByText('1 of 1 projects')).toBeVisible();
  await projectCard.click();

  await expect(page).toHaveURL(`/project/${PROJECT_ID}`);
  await page.getByRole('link', { name: 'Storyboard' }).click();
  await expect(page).toHaveURL(new RegExp(`/project/${PROJECT_ID}/storyboard`));
  await expect(page.locator('.scene-row')).toHaveCount(24);
  await expect(page.getByText('24 of 24 scenes')).toBeVisible();

  const secondRow = page.locator('.scene-row').nth(1);
  const secondSelect = secondRow.locator('.scene-row__select');
  await expect(secondSelect).toHaveAttribute('aria-describedby', 'scene-status-scene-02');
  await expect(page.locator('#scene-status-scene-02')).toContainText('RecordingMissing');
  await expect(secondRow.locator('.scene-row__actions')).toHaveCSS('opacity', '0');
  await secondRow.hover();
  await expect(secondRow.locator('.scene-row__actions')).toHaveCSS('opacity', '1');
  await secondSelect.click();
  await expect(page.getByRole('heading', { name: scenes[1]!.name })).toBeVisible();

  await page.getByRole('button', { name: 'Focus editor' }).click();
  await expect(page.locator('.project-sidebar')).toHaveCount(0);
  await expect(page.locator('.storyboard-rail')).toHaveCount(0);
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(`/project/${PROJECT_ID}`);
  await expect(page.locator('.project-sidebar')).toBeVisible();

  await page.getByRole('link', { name: 'Storyboard' }).click();
  await page.setViewportSize({ width: 600, height: 900 });
  await page.getByRole('button', { name: 'Focus editor' }).click();
  await page.locator('.storyboard-detail__editor').evaluate((editor) => {
    const spacer = document.createElement('div');
    spacer.setAttribute('data-e2e-scroll-spacer', 'true');
    spacer.style.height = '1800px';
    editor.append(spacer);
  });

  const contextBar = page.locator('.scene-context-bar');
  const workspaceMain = page.locator('.project-workspace__main');
  await workspaceMain.evaluate((element) => { element.scrollTop = 700; });
  await expect.poll(async () => (await workspaceMain.evaluate((element) => element.scrollTop)))
    .toBeGreaterThan(500);
  const pinned = await contextBar.boundingBox();
  await workspaceMain.evaluate((element) => { element.scrollTop = 1_100; });
  await expect.poll(async () => (await workspaceMain.evaluate((element) => element.scrollTop)))
    .toBeGreaterThan(900);
  const after = await contextBar.boundingBox();
  expect(pinned).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - pinned!.y)).toBeLessThanOrEqual(2);
  await expect(contextBar.locator('.scene-context-bar__title')).toHaveCSS('-webkit-line-clamp', '2');
  expect(await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)).toBe(true);
});
