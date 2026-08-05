import { describe, expect, it } from 'vitest';
import { resolveRecordingDurationLabel } from './RecordingInfo.js';

const presentation = {
  sourceKind: 'presentation' as const,
  sceneType: 'slide' as const,
  presentationSource: { hold_duration_sec: 5 },
  durationSec: 1,
};

describe('resolveRecordingDurationLabel', () => {
  it('uses narration rather than the physical clip duration for narrated slides', () => {
    expect(resolveRecordingDurationLabel({ ...presentation, hasNarrationAudio: true }))
      .toBe('Narration sets final length');
  });

  it('uses the configured hold rather than the physical clip duration for silent slides', () => {
    expect(resolveRecordingDurationLabel({ ...presentation, hasNarrationAudio: false }))
      .toBe('5s hold without narration');
  });

  it('preserves ordinary recording duration formatting', () => {
    expect(resolveRecordingDurationLabel({ durationSec: 65, hasNarrationAudio: false }))
      .toBe('1m 5s');
  });
});
