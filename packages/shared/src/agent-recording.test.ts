import { describe, expect, it } from 'vitest';
import { AgentRecordingPlanSchema, RecordingProvenanceSchema, RecordingSchema } from './index.js';

describe('agent recording schemas', () => {
  it('provides privacy-safe capture defaults', () => {
    const plan = AgentRecordingPlanSchema.parse({
      version: 1, projectId: 'p', projectName: 'demo', sceneId: 's', sceneName: 'Welcome', sceneType: 'browser',
      sourceFingerprint: 'abc', capture: {}, steps: [], preconditions: [], checkpoints: [], failurePolicy: 'stop-and-do-not-attach',
      attachmentEndpoint: '/recording', updatedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(plan.capture).toMatchObject({ targetKind: 'window', width: 1920, height: 1080, fps: 30, cursor: true, microphone: false, camera: false, systemAudio: false });
    expect(plan.rehearseFirst).toBe(true);
  });

  it('requires a session for Cap provenance and accepts legacy recordings', () => {
    expect(() => RecordingProvenanceSchema.parse({ source_kind: 'cap-agent' })).toThrow();
    expect(() => RecordingSchema.parse({ source: 'recordings/scene.mp4' })).not.toThrow();
  });
});
