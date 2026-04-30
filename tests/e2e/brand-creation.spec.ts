import { test, expect } from '@playwright/test';

test('create brand from free text and land on detail page', async ({ page }) => {
  await page.goto('http://localhost:5173/');

  // Navigate to New Brand wizard
  await page.getByRole('link', { name: /\+ New Brand/ }).click();
  await expect(page).toHaveURL(/\/brands\/new/);

  // Fill identity + free text
  await page.getByPlaceholder('e.g. Tanzu').fill('Acme Test Brand');
  await page.getByPlaceholder(/describe the brand/i).fill(
    'Acme is bold and clean. Primary color teal blue. Inter for headings.'
  );

  // Click Extract
  await page.getByRole('button', { name: /Extract/ }).click();

  // Wait for review screen (extraction + LLM token extraction happens async)
  await expect(page.getByRole('heading', { name: /Review extracted brand/ })).toBeVisible({ timeout: 30_000 });

  // Click Generate
  await page.getByRole('button', { name: /Generate design\.md/ }).click();

  // Land on detail page
  await expect(page).toHaveURL(/\/brands\/acme-test-brand/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /Acme Test Brand/ })).toBeVisible();

  // Download link should point to the API
  const dl = page.getByRole('link', { name: /Download design\.md/ });
  await expect(dl).toHaveAttribute('href', /\/api\/brands\/acme-test-brand\/download/);
});
