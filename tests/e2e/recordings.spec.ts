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
  await page.getByPlaceholder('my-demo').fill('e2e-recording');
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

  // Click first scene in sidebar to navigate to scene page
  await page.getByRole('link', { name: 'Introduction and Context' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/scene\/scene-01/);

  // Scene page should show scene name and recording tab
  await expect(page.getByRole('heading', { name: 'Introduction and Context' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recording' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Script' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Narration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lower Thirds' })).toBeVisible();

  // Recording tab should show "No recording" state with upload area
  await expect(page.getByText('No recording uploaded')).toBeVisible();
  await expect(page.getByText('Drop MP4 files here')).toBeVisible();
});

test('project overview shows recording counts', async ({ page }) => {
  // Create a project via "I have recordings" flow
  await page.goto('/');
  await page.getByRole('button', { name: 'I have recordings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('my-demo').fill('e2e-rec-overview');
  await page.getByRole('button', { name: 'Create' }).click();

  // Should land on project overview
  await expect(page).toHaveURL(/\/project\/[^/]+$/);
  await expect(page.getByRole('heading', { name: 'e2e-rec-overview' })).toBeVisible();

  // Recordings card should show — or 0/0 when no storyboard
  await expect(page.getByText('Recordings')).toBeVisible();
});
