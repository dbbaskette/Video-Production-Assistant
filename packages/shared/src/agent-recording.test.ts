import { describe, expect, it } from 'vitest';
import { AgentRehearsalEvidenceSchema, AgentRecordingPlanSchema, AgentReviewedCaptureSchema, CapSetupStatusSchema, RecordingProvenanceSchema, RecordingSchema } from './index.js';

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

  it('applies Cap setup defaults and rejects unknown permissions', () => {
    const status = CapSetupStatusSchema.parse({
      state: 'ready', installed: true, captureReady: true, missingPermissions: [], updatedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(status.targetCount).toBe(0);
    expect(() => CapSetupStatusSchema.parse({
      state: 'needs-permission', installed: true, captureReady: false, missingPermissions: ['camera'], updatedAt: '2026-07-31T12:00:00.000Z',
    })).toThrow();
  });

  it('parses successful rehearsal evidence', () => {
    expect(AgentRehearsalEvidenceSchema.parse({
      success: true,
      targetApplication: 'Safari',
      windowTitle: 'Demo',
      windowBounds: { x: 0, y: 20, width: 1440, height: 900 },
      completedStepIndexes: [0, 1],
      checkpoints: [{ description: 'Welcome screen is visible', passed: true }],
      resetConfirmed: true,
    })).toMatchObject({ success: true, resetConfirmed: true });
  });

  it('requires every reviewed capture field without applying editable-plan defaults', () => {
    const reviewedCapture = {
      targetApplication: 'Safari',
      startingUrl: '',
      targetKind: 'window',
      width: 1920,
      height: 1080,
      fps: 30,
      cursor: true,
      microphone: false,
      camera: false,
      systemAudio: false,
    };
    expect(AgentReviewedCaptureSchema.parse(reviewedCapture)).toEqual(reviewedCapture);
    expect(() => AgentReviewedCaptureSchema.parse({ targetApplication: 'Safari' })).toThrow();
    expect(() => AgentRehearsalEvidenceSchema.parse({
      success: true,
      targetApplication: 'Safari',
      windowTitle: 'Demo',
      windowBounds: { x: 0, y: 20, width: 1440, height: 900 },
      completedStepIndexes: [0],
      checkpoints: [],
      resetConfirmed: true,
      reviewedCapture: { targetApplication: 'Safari' },
    })).toThrow();
  });
});
