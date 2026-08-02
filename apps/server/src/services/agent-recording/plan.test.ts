import { describe, expect, it } from 'vitest';
import type { Project, Scene } from '@vpa/shared';
import { deriveAgentRecordingPlan } from './plan.js';

describe('deriveAgentRecordingPlan', () => {
  it('turns a shot plan into ordered capture actions without enabling audio or camera', () => {
    const project: Project = { id: '11111111-1111-4111-8111-111111111111', name: 'demo', path: '/tmp/demo', created: '2026-07-31T12:00:00.000Z', objective: 'Show the workflow', brand: null, model_routing: {} };
    const scene: Scene = { id: 'scene-1', name: 'Create item', description: 'Create a task', type: 'browser', shot_plan: [{ index: 4, action: 'Open the form' }, { index: 9, action: 'Save the item', note: 'Use demo data' }] };
    const plan = deriveAgentRecordingPlan(project, scene);
    expect(plan.steps.map((step) => step.action)).toEqual(['Open the form', 'Save the item']);
    expect(plan.steps.map((step) => step.index)).toEqual([0, 1]);
    expect(plan.capture).toMatchObject({ microphone: false, camera: false, systemAudio: false, targetKind: 'window' });
  });
});
