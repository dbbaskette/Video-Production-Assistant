import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Storyboard } from '@vpa/shared';
import { saveStoryboard } from '../storyboard/index.js';
import { RenderError, renderFinalVideo } from './index.js';

describe('renderFinalVideo cooperative cancellation', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'vpa-render-final-cancel-'));
    await mkdir(join(projectPath, 'recordings'), { recursive: true });
    await writeFile(join(projectPath, 'recordings', 'video.mp4'), 'not-real-video');
    const storyboard: Storyboard = {
      schema_version: 1,
      project: { id: '11111111-1111-4111-8111-111111111111', name: 'cancel-me', created: new Date().toISOString() },
      scenes: [
        { id: 'scene-01', name: 'A', description: '', type: 'desktop', recording: { source: 'recordings/video.mp4', duration_sec: 5 } },
        { id: 'scene-02', name: 'B', description: '', type: 'desktop', recording: { source: 'recordings/video.mp4', duration_sec: 5 } },
      ],
    };
    await saveStoryboard(projectPath, storyboard);
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('throws before any scene work when already cancelled', async () => {
    let polls = 0;
    await expect(
      renderFinalVideo(projectPath, { isCancelled: () => { polls += 1; return true; } }),
    ).rejects.toThrow('Render cancelled');
    // Checked at the top of the very first scene iteration.
    expect(polls).toBeGreaterThanOrEqual(1);
  });

  it('surfaces the cancellation as a RenderError so callers can branch on type', async () => {
    await expect(
      renderFinalVideo(projectPath, { isCancelled: () => true }),
    ).rejects.toBeInstanceOf(RenderError);
  });

  it('runs to completion when never cancelled (boundary poll returns false)', async () => {
    // No recordings that ffmpeg could actually process would be needed to
    // prove the happy-path poll doesn't throw — but a real run requires
    // ffmpeg, so instead assert that a false-returning poll still reaches the
    // pipeline (fails later on media, not on cancellation).
    let calls = 0;
    await expect(
      renderFinalVideo(projectPath, {
        isCancelled: () => { calls += 1; return false; },
      }),
    ).rejects.not.toThrow(/cancelled/i);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
