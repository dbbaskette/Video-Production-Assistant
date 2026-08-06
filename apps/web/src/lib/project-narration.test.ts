import { describe, expect, it } from 'vitest';
import type { Scene } from '@vpa/shared';
import { parseProjectNarrationResult, projectNarrationPreview } from './project-narration.js';

function scene(id: string, script?: string, audio?: string): Scene {
  return {
    id,
    name: id,
    description: id,
    type: 'desktop',
    narration: script === undefined ? undefined : {
      script,
      ...(audio ? { chunks: [{ index: 0, text: script, audio }] } : {}),
    },
  };
}

describe('project narration helpers', () => {
  const scenes = [
    scene('one', 'New script'),
    scene('two', 'Already narrated', 'two.mp3'),
    scene('three', 'Another script'),
    scene('four'),
    scene('five', '   '),
  ];

  it('previews preservation when overwrite is off', () => {
    expect(projectNarrationPreview(scenes, false)).toEqual({
      scriptedScenes: 3,
      willNarrateScenes: 2,
      preservedScenes: 1,
      noScriptScenes: 2,
    });
  });

  it('previews every scripted scene when overwrite is on', () => {
    expect(projectNarrationPreview(scenes, true)).toEqual({
      scriptedScenes: 3,
      willNarrateScenes: 3,
      preservedScenes: 0,
      noScriptScenes: 2,
    });
  });

  it('parses only bounded public terminal results', () => {
    expect(parseProjectNarrationResult({
      totalScenes: 5,
      generatedScenes: 2,
      generatedChunks: 4,
      preservedScenes: 1,
      noScriptScenes: 2,
      removedScenes: 0,
      failedScenes: 1,
      cancelled: false,
      failures: [{ sceneId: 'one', sceneName: 'One', code: 'scene_generation_failed', secret: '/tmp/key' }],
      providerError: '/private/key exploded',
    })).toEqual({
      totalScenes: 5,
      generatedScenes: 2,
      generatedChunks: 4,
      preservedScenes: 1,
      noScriptScenes: 2,
      removedScenes: 0,
      failedScenes: 1,
      cancelled: false,
      failures: [{ sceneId: 'one', sceneName: 'One', code: 'scene_generation_failed' }],
    });
    expect(parseProjectNarrationResult({ totalScenes: 'five' })).toBeNull();
  });
});
