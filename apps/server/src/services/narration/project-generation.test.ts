import { describe, expect, it, vi } from 'vitest';
import type { Scene, Storyboard } from '@vpa/shared';
import { inspectNarrationBatch } from './index.js';
import { generateProjectNarration } from './project-generation.js';

function scene(id: string, script?: string): Scene {
  return {
    id,
    name: id,
    description: id,
    type: 'desktop',
    ...(script === undefined ? {} : { narration: { script } }),
  };
}

function storyboard(scenes: Scene[]): Storyboard {
  return {
    schema_version: 1,
    project: { id: 'project-1', name: 'Project', created: '2026-08-06', objective: 'Test' },
    scenes,
  };
}

function input(scenes: Scene[], overwrite = false) {
  return {
    projectPath: '/safe/project',
    scenes: scenes.map(({ id, name }) => ({ id, name })),
    engine: 'gemini',
    voice: 'Kore',
    speed: 1,
    expressiveness: 'medium' as const,
    overwrite,
  };
}

describe('generateProjectNarration', () => {
  it('generates only missing scripted scenes and preserves completed audio', async () => {
    const one = scene('scene-01', 'Generate me.');
    const two = scene('scene-02');
    const three = scene('scene-03', 'Keep me.');
    three.narration!.chunks = [{ index: 0, text: 'Keep me.', audio: 'narration/three.mp3' }];
    const current = storyboard([one, two, three]);
    const generateScene = vi.fn().mockResolvedValue({ total: 1, completed: 1, failed: 0 });
    const resolveWriter = vi.fn();

    const result = await generateProjectNarration(input(current.scenes), {
      loadStoryboard: vi.fn().mockResolvedValue(current),
      inspectBatch: inspectNarrationBatch,
      resolveWriter,
      generateScene,
      onProgress: vi.fn(),
      isCancelled: () => false,
    });

    expect(generateScene).toHaveBeenCalledTimes(1);
    expect(generateScene).toHaveBeenCalledWith(
      expect.objectContaining({ sceneId: 'scene-01', selector: 'missing' }),
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
    expect(resolveWriter).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      totalScenes: 3,
      generatedScenes: 1,
      generatedChunks: 1,
      preservedScenes: 1,
      noScriptScenes: 1,
      failedScenes: 0,
      cancelled: false,
    });
  });

  it('uses selector all when overwrite is enabled', async () => {
    const existing = scene('scene-01', 'Replace me.');
    existing.narration!.chunks = [{ index: 0, text: 'Replace me.', audio: 'old.mp3' }];
    const generateScene = vi.fn().mockResolvedValue({ total: 1, completed: 1, failed: 0 });

    await generateProjectNarration(input([existing], true), {
      loadStoryboard: vi.fn().mockResolvedValue(storyboard([existing])),
      inspectBatch: inspectNarrationBatch,
      resolveWriter: vi.fn(),
      generateScene,
      onProgress: vi.fn(),
      isCancelled: () => false,
    });

    expect(generateScene).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'all' }),
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('reloads each scene and handles removed scripts and scenes', async () => {
    const one = scene('scene-01', 'Was scripted.');
    const two = scene('scene-02', 'Was present.');
    const loadStoryboard = vi.fn()
      .mockResolvedValueOnce(storyboard([scene('scene-01'), two]))
      .mockResolvedValueOnce(storyboard([scene('scene-01')]));
    const generateScene = vi.fn();

    const result = await generateProjectNarration(input([one, two]), {
      loadStoryboard,
      inspectBatch: inspectNarrationBatch,
      resolveWriter: vi.fn(),
      generateScene,
      onProgress: vi.fn(),
      isCancelled: () => false,
    });

    expect(loadStoryboard).toHaveBeenCalledTimes(2);
    expect(generateScene).not.toHaveBeenCalled();
    expect(result.noScriptScenes).toBe(1);
    expect(result.removedScenes).toBe(1);
  });

  it('resolves a writer only for selected xAI chunks, including dialog overrides', async () => {
    const dialog = scene('scene-01', '[Speaker A] Hello.');
    dialog.narration = {
      mode: 'dialog',
      script: '[Speaker A] Hello.',
      speakers: { A: { engine: 'xai', voice: 'Ara' } },
    };
    const writer = { complete: vi.fn() } as any;
    const resolveWriter = vi.fn().mockResolvedValue(writer);
    const generateScene = vi.fn().mockResolvedValue({ total: 1, completed: 1, failed: 0 });

    await generateProjectNarration(input([dialog]), {
      loadStoryboard: vi.fn().mockResolvedValue(storyboard([dialog])),
      inspectBatch: inspectNarrationBatch,
      resolveWriter,
      generateScene,
      onProgress: vi.fn(),
      isCancelled: () => false,
    });

    expect(resolveWriter).toHaveBeenCalledTimes(1);
    expect(generateScene.mock.calls[0]![1]).toBe(writer);
  });

  it('continues after scene failures and caps public failure details', async () => {
    const scenes = Array.from({ length: 22 }, (_, index) => scene(`scene-${index}`, 'Narrate.'));

    const result = await generateProjectNarration(input(scenes), {
      loadStoryboard: vi.fn().mockResolvedValue(storyboard(scenes)),
      inspectBatch: inspectNarrationBatch,
      resolveWriter: vi.fn(),
      generateScene: vi.fn().mockRejectedValue(new Error('/private/key provider exploded')),
      onProgress: vi.fn(),
      isCancelled: () => false,
    });

    expect(result.failedScenes).toBe(22);
    expect(result.failures).toHaveLength(20);
    expect(result.failures[0]).toEqual({
      sceneId: 'scene-0',
      sceneName: 'scene-0',
      code: 'scene_generation_failed',
    });
    expect(JSON.stringify(result)).not.toContain('provider exploded');
  });

  it('stops at a scene boundary when cancelled', async () => {
    const scenes = [scene('scene-01', 'One.'), scene('scene-02', 'Two.')];
    let cancelled = false;
    const generateScene = vi.fn().mockImplementation(async () => {
      cancelled = true;
      return { total: 1, completed: 1, failed: 0 };
    });

    const result = await generateProjectNarration(input(scenes), {
      loadStoryboard: vi.fn().mockResolvedValue(storyboard(scenes)),
      inspectBatch: inspectNarrationBatch,
      resolveWriter: vi.fn(),
      generateScene,
      onProgress: vi.fn(),
      isCancelled: () => cancelled,
    });

    expect(generateScene).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
  });
});
