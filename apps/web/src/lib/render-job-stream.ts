/**
 * Pure state machine for the Render page's render-job SSE stream.
 *
 * RenderSection must behave identically whether a render was started in this
 * mount (startRender.onSuccess) or recovered after navigation (adopting an
 * active job from /api/jobs?active=1). Both paths feed events through
 * `applyRenderJobEvent`, so recovery and live progress share one tested code
 * path. Event types come from the server's job stream: 'progress', 'done',
 * 'error', 'cancel-requested', 'cancel'.
 */

export interface RenderProgressEvent {
  type: 'step';
  step: 'concat-audio' | 'mux-scene' | 'concat-scenes' | 'mix-music' | 'done';
  sceneIndex?: number;
  sceneId?: string;
  totalScenes?: number;
  message: string;
}

export interface RenderJobUiState {
  /** Latest progress event, or null before the first one arrives. */
  progress: RenderProgressEvent | null;
  /** Terminal error message, or null. */
  error: string | null;
  /** Wall-clock time a successful (non-cancelled) finish was observed. */
  doneAt: number | null;
  /** True once the user has requested cancellation but ffmpeg may still run. */
  cancelRequested: boolean;
  /** True when the job reached any terminal state — stop treating it as active. */
  finished: boolean;
}

export function initialRenderJobState(): RenderJobUiState {
  return { progress: null, error: null, doneAt: null, cancelRequested: false, finished: false };
}

function eventError(data: unknown): string | null {
  if (data && typeof data === 'object' && 'error' in data) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Render failed';
}

export function applyRenderJobEvent(
  state: RenderJobUiState,
  event: { type: string; data?: unknown },
): RenderJobUiState {
  switch (event.type) {
    case 'progress':
      return { ...state, progress: event.data as RenderProgressEvent };
    case 'cancel-requested':
      // The render pipeline stops at the next safe scene boundary; keep the
      // last progress visible while that drains.
      return { ...state, cancelRequested: true };
    case 'done': {
      const cancelled =
        !!event.data && typeof event.data === 'object' && 'cancelled' in event.data
        && (event.data as { cancelled?: unknown }).cancelled === true;
      if (cancelled) {
        return { ...initialRenderJobState(), finished: true };
      }
      return { ...state, progress: null, error: null, doneAt: Date.now(), finished: true };
    }
    case 'error':
      return { ...state, progress: null, error: eventError(event.data), finished: true };
    case 'cancel':
      // Server-side immediate cancel (job was not running yet).
      return { ...initialRenderJobState(), finished: true };
    default:
      return state;
  }
}
