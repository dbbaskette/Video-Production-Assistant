import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakeLlm } from '../llm/index.js';
import { runQualityReview } from './index.js';
import type { Storyboard } from '@vpa/shared';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../../..');
}

function makeSampleStoryboard(): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: randomUUID(),
      name: 'test-proj',
      created: new Date().toISOString(),
      objective: 'Demo quality review',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Introduction', type: 'desktop' },
      { id: 'scene-02', name: 'Setup', description: 'Setting up', type: 'terminal' },
    ],
  };
}

describe('quality review service', () => {
  it('returns review items with summary', async () => {
    const llm = createFakeLlm();
    const sb = makeSampleStoryboard();
    const result = await runQualityReview(sb, llm, workspaceRoot());

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.summary.total).toBe(result.items.length);
    expect(result.summary.info + result.summary.warn + result.summary.issue).toBe(result.summary.total);
    expect(['ok', 'warnings', 'issues']).toContain(result.status);
    expect(result.reviewedAt).toBeTruthy();
  });

  it('items have required fields', async () => {
    const llm = createFakeLlm();
    const sb = makeSampleStoryboard();
    const result = await runQualityReview(sb, llm, workspaceRoot());

    for (const item of result.items) {
      expect(item.sceneId).toBeTruthy();
      expect(['info', 'warn', 'issue']).toContain(item.severity);
      expect(item.category).toBeTruthy();
      expect(item.message).toBeTruthy();
    }
  });

  it('status reflects worst severity', async () => {
    const llm = createFakeLlm();
    const sb = makeSampleStoryboard();
    const result = await runQualityReview(sb, llm, workspaceRoot());

    // Fake LLM returns warn items, so status should be 'warnings'
    expect(result.status).toBe('warnings');
  });
});
