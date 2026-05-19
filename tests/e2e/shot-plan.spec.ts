import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('shot-plan: plan shots, accept, print', async ({ page }) => {
  // Create a project via "Ideate a new demo"
  await page.goto('/');
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('MCP Demo Test').fill('e2e-shot-plan');
  await page.getByRole('button', { name: 'Create & start ideating' }).click();

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

  // Click the first scene in the left-rail scene list.
  // The storyboard is a master-detail layout: scenes are shown as buttons in
  // the left rail; clicking one updates ?scene= and renders the ScenePage
  // inline on the right. URL stays at /storyboard (no navigation to /scene/*).
  await page.getByRole('button', { name: 'Introduction and Context' }).click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/storyboard\?scene=scene-01/);

  // Step 7: Assert "Plan shots" button is visible (ShotPlanSection in empty state)
  await expect(page.getByRole('button', { name: 'Plan shots' })).toBeVisible();

  // Step 8: Click "Plan shots" to enter chat mode
  await page.getByRole('button', { name: 'Plan shots' }).click();

  // Step 9: Fill the chat textarea and send
  const chatTextarea = page.getByPlaceholder('Tell the AI what to add, remove, or clarify…');
  await chatTextarea.fill('Plan it');
  // Scope the Send button to the shot-plan section's chat bar
  await chatTextarea
    .locator('../..')
    .getByRole('button', { name: 'Send' })
    .click();

  // Step 10: Wait for proposed steps to appear in the right-side panel
  await expect(page.getByText(/Proposed steps \(/)).toBeVisible({ timeout: 15000 });

  // Step 11: Confirm the expected step text is shown
  await expect(page.getByText('Open a new Terminal window')).toBeVisible();

  // Step 12: Accept the plan
  await page.getByRole('button', { name: 'Accept plan' }).click();

  // Step 13: Verify accepted-state checklist — same step text in a label with checkbox
  await expect(page.getByRole('checkbox').first()).toBeVisible();
  await expect(page.getByText('Open a new Terminal window')).toBeVisible();

  // Step 14: Verify the print link opens a new tab with the step list
  const [printPage] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('link', { name: /open print view/i }).click(),
  ]);
  await printPage.waitForLoadState();
  await expect(printPage.locator('ol li').first()).toBeVisible();
});
