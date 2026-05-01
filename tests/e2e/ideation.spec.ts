import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('ideation flow: create project, chat, accept storyboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Video Production Assistant' })).toBeVisible();

  // Click "Ideate a new demo" to open the new project dialog
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  // Create a new project
  await page.getByPlaceholder('my-demo').fill('e2e-ideation');
  await page.getByRole('button', { name: 'Create' }).click();

  // Should navigate to the ideation page
  await expect(page).toHaveURL(/\/project\/[^/]+\/ideation/);
  await expect(page.getByText('Demo Ideation')).toBeVisible();
  await expect(page.getByText('What would you like to demo?')).toBeVisible();

  // Type a message in the chat
  await page.getByPlaceholder('Describe what you want to demo…').fill(
    'I want to demo setting up an MCP server with Claude Desktop',
  );
  await page.getByRole('button', { name: 'Send' }).click();

  // Wait for AI response — check for scene text (use .first() since it appears in both chat and preview)
  await expect(page.getByText('Proposed Scenes').first()).toBeVisible({ timeout: 10000 });

  // The storyboard preview on the right should show scene count
  await expect(page.getByText('6 scenes')).toBeVisible();

  // Accept the storyboard
  await page.getByRole('button', { name: 'Accept & Create Storyboard' }).click();

  // Should navigate to storyboard view
  await expect(page).toHaveURL(/\/project\/[^/]+\/storyboard/);
  await expect(page.getByRole('heading', { name: 'Storyboard' })).toBeVisible();
});

test('project workspace navigation', async ({ page }) => {
  // First create a project to navigate to
  await page.goto('/');
  await page.getByRole('button', { name: 'I have recordings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('my-demo').fill('e2e-nav-test');
  await page.getByRole('button', { name: 'Create' }).click();

  // Should land on project overview (via the "I have recordings" button)
  await expect(page).toHaveURL(/\/project\/[^/]+$/);
  await expect(page.getByRole('heading', { name: 'e2e-nav-test' })).toBeVisible();

  // Navigate to ideation via sidebar (use exact to avoid "Start Ideation" link on overview)
  await page.getByRole('link', { name: 'Ideation', exact: true }).click();
  await expect(page).toHaveURL(/\/ideation$/);

  // Navigate to storyboard via sidebar
  await page.getByRole('link', { name: 'Storyboard', exact: true }).click();
  await expect(page).toHaveURL(/\/storyboard$/);

  // Navigate back to all projects
  await page.getByRole('link', { name: '← All projects' }).click();
  await expect(page).toHaveURL('/');
});
