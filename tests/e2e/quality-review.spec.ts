import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('quality review page runs review and displays results', async ({ page }) => {
  // Create project via ideation
  await page.goto('/');
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('my-demo').fill('e2e-qr');
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

  // Navigate to Quality Review via sidebar
  await page.getByRole('link', { name: 'Quality Review' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/review/);

  // Should show empty state
  await expect(page.getByText('No review has been run yet')).toBeVisible();

  // Run the review
  await page.getByRole('button', { name: 'Run Quality Review' }).click();

  // Should show results — summary bar and items
  await expect(
    page.getByText(/items:/).or(page.getByText('All Good')).or(page.getByText('Warnings Found')).or(page.getByText('Issues Found')),
  ).toBeVisible({ timeout: 10000 });

  // Should have review items grouped by scene
  await expect(page.getByText('Go to scene').first()).toBeVisible();
});
