import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('script tab generates and displays a narration script', async ({ page }) => {
  // Create a project with ideation to get a storyboard
  await page.goto('/');
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('my-demo').fill('e2e-script');
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

  // Navigate to first scene
  await page.getByRole('link', { name: 'Introduction and Context' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/scene\/scene-01/);

  // Switch to Script tab
  await page.getByRole('button', { name: 'Script' }).click();

  // Should show empty state with Generate button
  await expect(page.getByText('No script yet')).toBeVisible();
  await expect(page.getByRole('button', { name: /Generate Script/ })).toBeVisible();

  // Generate a script
  await page.getByRole('button', { name: /Generate Script/ }).click();

  // Should show the generated script in a textarea
  const textarea = page.locator('textarea');
  await expect(textarea).toBeVisible({ timeout: 10000 });
  const scriptContent = await textarea.inputValue();
  expect(scriptContent).toBeTruthy();
  expect(scriptContent).toContain('['); // emotive tags

  // Regenerate and Save buttons should now be visible
  await expect(page.getByRole('button', { name: /Regenerate/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Save/ })).toBeVisible();

  // Edit the script to make it dirty
  await textarea.fill('Custom edited script content');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  // Save the edited script
  await page.getByRole('button', { name: /Save/ }).click();

  // Unsaved changes indicator should disappear
  await expect(page.getByText('Unsaved changes')).not.toBeVisible({ timeout: 5000 });
});
