import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('lower thirds tab recommends and displays editable overlays', async ({ page }) => {
  // Create project via ideation
  await page.goto('/');
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('my-demo').fill('e2e-lt');
  await page.getByRole('button', { name: 'Create' }).click();

  // Run ideation
  await expect(page).toHaveURL(/\/project\/[^/]+\/ideation/);
  await page.getByPlaceholder('Describe what you want to demo…').fill(
    'Demo setting up a basic Node.js server',
  );
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Proposed Scenes').first()).toBeVisible({ timeout: 10000 });

  // Accept storyboard
  await page.getByRole('button', { name: 'Accept & Create Storyboard' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/storyboard/);

  // Navigate to scene
  await page.getByRole('link', { name: 'Introduction and Context' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/scene\/scene-01/);

  // Switch to Lower Thirds tab
  await page.getByRole('button', { name: 'Lower Thirds' }).click();

  // Should show empty state with Recommend button
  await expect(page.getByText('No lower thirds yet')).toBeVisible();
  await expect(page.getByRole('button', { name: /Recommend Lower Thirds/ })).toBeVisible();

  // Recommend
  await page.getByRole('button', { name: /Recommend Lower Thirds/ }).click();

  // Should show editable lower thirds
  await expect(page.getByText('Title').first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Subtitle').first()).toBeVisible();

  // Should have style, in/out timing controls
  await expect(page.getByText('Style').first()).toBeVisible();
  await expect(page.getByText('In (s)').first()).toBeVisible();
  await expect(page.getByText('Out (s)').first()).toBeVisible();
});
