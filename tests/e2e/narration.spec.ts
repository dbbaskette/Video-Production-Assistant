import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('narration tab generates audio and shows player', async ({ page }) => {
  // Create project via ideation
  await page.goto('/');
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('my-demo').fill('e2e-narration');
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

  // First, generate a script (required before narration)
  await page.getByRole('button', { name: 'Script' }).click();
  await page.getByRole('button', { name: /Generate Script/ }).click();
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });

  // Switch to Narration tab
  await page.getByRole('button', { name: 'Narration' }).click();

  // Should show TTS controls since we have a script
  await expect(page.getByText('TTS Engine')).toBeVisible();
  await expect(page.getByText('Voice')).toBeVisible();
  await expect(page.getByRole('button', { name: /Generate Narration/ })).toBeVisible();

  // Generate narration
  await page.getByRole('button', { name: /Generate Narration/ }).click();

  // Should show audio player after generation
  await expect(page.locator('audio')).toBeVisible({ timeout: 10000 });

  // Should show engine/voice metadata
  await expect(page.getByText('Engine: fake')).toBeVisible();
  await expect(page.getByText('Voice: alice')).toBeVisible();

  // Subtitle info should appear
  await expect(page.getByText('SRT')).toBeVisible();
  await expect(page.getByText('VTT')).toBeVisible();

  // Button should now say "Regenerate"
  await expect(page.getByRole('button', { name: /Regenerate/ })).toBeVisible();
});
