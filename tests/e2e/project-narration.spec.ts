import { expect, test } from '@playwright/test';

const API = 'http://127.0.0.1:3000';

test('narrates the whole project while preserving audio unless overwrite is selected', async ({ page, request }) => {
  const name = `e2e-project-narration-${Date.now()}`;
  const created = await request.post(`${API}/api/projects`, {
    data: {
      name,
      parentDir: '/tmp/vpa-e2e-projects',
      objective: 'Project narration acceptance test',
      brand: null,
    },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json() as { id: string };

  try {
    const storyboard = {
      schema_version: 1,
      project: { id: project.id, name, created: new Date().toISOString(), objective: 'Test' },
      scenes: [
        { id: 'scene-a', name: 'Needs narration', description: '', type: 'desktop', narration: { script: 'Generate this scene.' } },
        { id: 'scene-b', name: 'No script', description: '', type: 'desktop', narration: { script: '   ' } },
        {
          id: 'scene-c',
          name: 'Existing narration',
          description: '',
          type: 'desktop',
          narration: {
            script: 'Preserve this scene.',
            chunks: [{ index: 0, text: 'Preserve this scene.', audio: 'narration/original.mp3', durationSec: 1 }],
          },
        },
      ],
    };
    const saved = await request.put(`${API}/api/projects/${project.id}/storyboard`, { data: storyboard });
    expect(saved.ok()).toBe(true);

    await page.goto(`/project/${project.id}/narration`);
    await expect(page.getByRole('heading', { name: 'Narrate all scripted scenes' })).toBeVisible();
    await page.getByLabel('Narration engine').selectOption('fake');
    await page.getByLabel('Narration voice').selectOption('alice');
    await expect(page.getByLabel('Narration preview')).toContainText('1 scene will be narrated');
    await expect(page.getByLabel('Narration preview')).toContainText('1 existing narration preserved');
    await expect(page.getByLabel('Narration preview')).toContainText('1 without scripts skipped');

    await page.getByRole('button', { name: 'Narrate project' }).click();
    const projectStatus = page.locator('.project-narration-panel').getByRole('status');
    await expect(projectStatus).toContainText('Narration complete', { timeout: 10_000 });

    const afterPreserve = await (await request.get(`${API}/api/projects/${project.id}/storyboard`)).json();
    expect(afterPreserve.scenes[0].narration.chunks[0].audio).toBeTruthy();
    expect(afterPreserve.scenes[1].narration.chunks).toBeUndefined();
    expect(afterPreserve.scenes[2].narration.chunks[0].audio).toBe('narration/original.mp3');

    await page.getByLabel('Overwrite existing narration').check();
    await expect(page.getByLabel('Narration preview')).toContainText('2 scenes will be narrated');
    await page.getByRole('button', { name: 'Narrate project' }).click();
    await expect.poll(async () => {
      const current = await (await request.get(`${API}/api/projects/${project.id}/storyboard`)).json();
      return current.scenes[2].narration.chunks[0].audio;
    }, { timeout: 10_000 }).not.toBe('narration/original.mp3');
    await expect(projectStatus).toContainText('Narration complete');
  } finally {
    await request.delete(`${API}/api/projects/${project.id}/tracker`);
  }
});
