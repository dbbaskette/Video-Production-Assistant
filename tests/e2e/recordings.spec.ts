import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('scene page loads from storyboard and shows recording tab', async ({ page }) => {
  // Create a project with ideation to get a storyboard
  await page.goto('/');
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('MCP Demo Test').fill('e2e-recording');
  await page.getByRole('button', { name: 'Create' }).click();

  // Run ideation to create scenes
  await expect(page).toHaveURL(/\/project\/[^/]+\/ideation/);
  await page.getByPlaceholder('Describe what you want to demo…').fill(
    'Demo setting up a basic Node.js server',
  );
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Proposed Scenes').first()).toBeVisible({ timeout: 10000 });

  // Accept storyboard
  await page.getByRole('button', { name: 'Accept & Create Storyboard' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/storyboard/);

  // Pick the generated browser scene in the master-detail storyboard.
  await page.getByRole('button', { name: /browser/ }).first().click();

  // Embedded scene editor should expose all workflow tabs.
  await expect(page.getByRole('button', { name: 'Recording', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Script', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Narration', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lower Thirds', exact: true })).toBeVisible();

  // Recording tab should show "No recording" state with upload area
  await expect(page.getByText('No recording uploaded')).toBeVisible();
  await expect(page.getByText('Drop MP4 files here')).toBeVisible();

  // Agent recording is a reviewed handoff, not an automatic recorder launch.
  await expect(page.getByRole('button', { name: 'Record with Codex' })).toBeEnabled();
  await page.getByRole('button', { name: 'Record with Codex' }).click();
  await expect(page.getByRole('heading', { name: 'Prepare agent recording' })).toBeVisible();
  await expect(page.getByText('VPA prepares the instructions')).toBeVisible();
  await page.getByLabel('Target application').fill('Safari');
  await expect(page.getByRole('button', { name: 'Save & copy Codex handoff' })).toBeEnabled();
  await page.getByRole('button', { name: 'Close' }).click();
});

test('project overview shows recording counts', async ({ page }) => {
  // Create a project via "I have recordings" flow
  await page.goto('/');
  await page.getByRole('button', { name: 'I have recordings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('MCP Demo Test').fill('e2e-rec-overview');
  await page.getByRole('button', { name: 'Create' }).click();

  // Recording-first creation lands on Recordings; use the workspace nav to inspect the overview.
  await expect(page).toHaveURL(/\/project\/[^/]+\/recordings$/);
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+$/);
  await expect(page.getByRole('heading', { name: 'e2e-rec-overview' })).toBeVisible();

  // Recordings card should show — or 0/0 when no storyboard
  await expect(page.getByLabel('Project status').getByText('Recordings', { exact: true })).toBeVisible();
  await expect(page.getByText(/Project progress/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Project issues/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Project health' })).toHaveCount(0);
});
