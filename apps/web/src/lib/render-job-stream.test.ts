import { describe, expect, it } from 'vitest';
import {
  applyRenderJobEvent,
  initialRenderJobState,
} from './render-job-stream.js';

describe('render-job-stream state machine', () => {
  it('starts idle with no progress, error, or completion', () => {
    expect(initialRenderJobState()).toEqual({
      progress: null,
      error: null,
      doneAt: null,
      cancelRequested: false,
      finished: false,
    });
  });

  it('stores the latest progress event and keeps the job active', () => {
    let state = initialRenderJobState();
    state = applyRenderJobEvent(state, {
      type: 'progress',
      data: { type: 'step', step: 'mux-scene', sceneIndex: 1, totalScenes: 3, message: 'Rendering scene 2/3' },
    });
    expect(state.progress?.step).toBe('mux-scene');
    expect(state.finished).toBe(false);

    state = applyRenderJobEvent(state, {
      type: 'progress',
      data: { type: 'step', step: 'concat-scenes', totalScenes: 3, message: 'Joining scenes' },
    });
    expect(state.progress?.step).toBe('concat-scenes');
    expect(state.error).toBeNull();
  });

  it('marks cancellation requested without discarding live progress', () => {
    let state = applyRenderJobStateWithProgress();
    state = applyRenderJobEvent(state, { type: 'cancel-requested' });
    expect(state.cancelRequested).toBe(true);
    expect(state.progress).not.toBeNull();
    expect(state.finished).toBe(false);
  });

  it('treats a successful done as complete with doneAt set and progress cleared', () => {
    let state = applyRenderJobStateWithProgress();
    const before = Date.now();
    state = applyRenderJobEvent(state, { type: 'done', data: { outputPath: '/tmp/final.mp4' } });
    expect(state.finished).toBe(true);
    expect(state.doneAt).not.toBeNull();
    expect(state.doneAt!).toBeGreaterThanOrEqual(before);
    expect(state.progress).toBeNull();
    expect(state.error).toBeNull();
  });

  it('treats a done event carrying cancelled:true as a bare finish (no doneAt)', () => {
    let state = applyRenderJobStateWithProgress();
    state = applyRenderJobEvent(state, { type: 'done', data: { cancelled: true } });
    expect(state.finished).toBe(true);
    expect(state.doneAt).toBeNull();
    expect(state.progress).toBeNull();
  });

  it('captures the server error message on failure', () => {
    let state = applyRenderJobStateWithProgress();
    state = applyRenderJobEvent(state, { type: 'error', data: { error: 'ffmpeg lacks freetype' } });
    expect(state.finished).toBe(true);
    expect(state.error).toBe('ffmpeg lacks freetype');
    expect(state.progress).toBeNull();
  });

  it('falls back to a generic message when an error event has no payload', () => {
    let state = initialRenderJobState();
    state = applyRenderJobEvent(state, { type: 'error' });
    expect(state.error).toBe('Render failed');
  });

  it('resets transient state when the server cancels immediately', () => {
    let state = applyRenderJobStateWithProgress();
    state = applyRenderJobEvent(state, { type: 'cancel-requested' });
    state = applyRenderJobEvent(state, { type: 'cancel' });
    expect(state.finished).toBe(true);
    expect(state.progress).toBeNull();
    expect(state.cancelRequested).toBe(false);
    expect(state.doneAt).toBeNull();
  });

  it('ignores unknown event types', () => {
    const state = applyRenderJobStateWithProgress();
    expect(applyRenderJobEvent(state, { type: 'mystery' })).toEqual(state);
  });
});

function applyRenderJobStateWithProgress() {
  return applyRenderJobEvent(initialRenderJobState(), {
    type: 'progress',
    data: { type: 'step', step: 'concat-audio', sceneIndex: 0, totalScenes: 2, message: 'Preparing audio' },
  });
}
