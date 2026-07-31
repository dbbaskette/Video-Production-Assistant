import { describe, expect, it } from 'vitest';
import { WorkflowStatusSchema } from './workflow-status.js';

describe('WorkflowStatusSchema', () => {
  it('accepts a canonical seven-step response', () => {
    const keys = ['storyboard', 'recordings', 'script', 'narration', 'lower-thirds', 'render', 'review'] as const;
    expect(() => WorkflowStatusSchema.parse({
      projectId: 'project-1',
      computedAt: new Date().toISOString(),
      steps: keys.map((key) => ({ key, label: key, state: 'complete', summary: 'Done', completed: 1, total: 1 })),
      nextAction: { key: 'open_review', label: 'Review project', summary: 'Everything is ready.' },
      issues: [],
      counts: { blockers: 0, warnings: 0 },
      progress: { completed: 7, total: 7, percent: 100 },
      render: { ready: true, readyScenes: 1, totalScenes: 1, blockers: [], warnings: [], output: { state: 'current' } },
    })).not.toThrow();
  });
});
