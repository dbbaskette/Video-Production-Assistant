import { describe, expect, it } from 'vitest';
import type { AgentRecordingSession } from '@vpa/shared';
import {
  hasSessionBoundConfirmationEvidence,
  isActiveAgentRecordingSession,
  shouldCloseAfterObservedCompletion,
} from './agent-recording-ui.js';

const baseSession: AgentRecordingSession = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'project',
  sceneId: 'scene',
  state: 'awaiting_confirmation',
  createdAt: '2026-07-31T12:00:00.000Z',
  updatedAt: '2026-07-31T12:00:01.000Z',
  planFingerprint: 'fingerprint',
  rehearsal: {
    success: true,
    targetApplication: 'MeetingNotes',
    windowTitle: 'Settings',
    windowBounds: { x: 0, y: 0, width: 1280, height: 720 },
    completedStepIndexes: [0],
    checkpoints: [{ description: 'Settings visible', passed: true }],
    resetConfirmed: true,
    reviewedCapture: {
      targetApplication: 'MeetingNotes', startingUrl: '', targetKind: 'window',
      width: 1920, height: 1080, fps: 30, cursor: true,
      microphone: false, camera: false, systemAudio: false,
    },
    reviewedSteps: [{ index: 0, action: 'Open Settings' }],
  },
};

describe('agent recording UI session boundaries', () => {
  it('requires capture settings and actions bound into the rehearsal session before confirmation', () => {
    expect(hasSessionBoundConfirmationEvidence(baseSession)).toBe(true);
    expect(hasSessionBoundConfirmationEvidence({
      ...baseSession,
      rehearsal: { ...baseSession.rehearsal!, reviewedCapture: undefined },
    })).toBe(false);
    expect(hasSessionBoundConfirmationEvidence({
      ...baseSession,
      rehearsal: { ...baseSession.rehearsal!, completedStepIndexes: [] },
    })).toBe(false);
    expect(hasSessionBoundConfirmationEvidence({
      ...baseSession,
      rehearsal: { ...baseSession.rehearsal!, targetApplication: 'Another App' },
    })).toBe(false);
    expect(hasSessionBoundConfirmationEvidence({
      ...baseSession,
      rehearsal: {
        ...baseSession.rehearsal!,
        reviewedCapture: { targetApplication: 'MeetingNotes' },
      },
    } as unknown as AgentRecordingSession)).toBe(false);
  });

  it('distinguishes active recording states from terminal history', () => {
    expect(isActiveAgentRecordingSession(baseSession)).toBe(true);
    expect(isActiveAgentRecordingSession({ ...baseSession, state: 'completed' })).toBe(false);
  });

  it('closes only for the active session observed by this dialog', () => {
    const completed = { ...baseSession, state: 'completed' as const };
    expect(shouldCloseAfterObservedCompletion(completed.id, completed)).toBe(true);
    expect(shouldCloseAfterObservedCompletion(null, completed)).toBe(false);
    expect(shouldCloseAfterObservedCompletion('22222222-2222-4222-8222-222222222222', completed)).toBe(false);
  });
});
