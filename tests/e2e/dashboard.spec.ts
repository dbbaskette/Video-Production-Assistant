import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('dashboard renders, creates a project, lists it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Video Production Assistant' })).toBeVisible();

  await expect(page.getByText('No projects yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('my-demo').fill('e2e-smoke');
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('e2e-smoke', { exact: true })).toBeVisible();
});
