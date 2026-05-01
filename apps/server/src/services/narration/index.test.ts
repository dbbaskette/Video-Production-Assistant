import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TtsService, createFakeTtsProvider } from '../tts/index.js';
import { saveStoryboard, loadStoryboard } from '../storyboard/index.js';
import { generateNarration } from './index.js';
import type { Storyboard } from '@vpa/shared';

function makeSampleStoryboard(): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: randomUUID(),
      name: 'test-proj',
      created: new Date().toISOString(),
      objective: 'Demo narration',
    },
    scenes: [
      {
        id: 'scene-01',
        name: 'Intro',
        description: 'Introduction to the demo',
        type: 'desktop',
        narration: {
          script: '[warm] Welcome to this demo. [confident] Let me show you how it works.',
        },
      },
      {
        id: 'scene-02',
        name: 'Setup',
        description: 'Setting up the environment',
        type: 'terminal',
        // No script — should fail
      },
    ],
  };
}

describe('narration service', () => {
  let projectPath: string;
  let tts: TtsService;

  beforeEach(async () => {
    projectPath = await mkdtemp(path.join(tmpdir(), 'vpa-narration-'));
    tts = new TtsService();
    tts.register(createFakeTtsProvider());
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('generates narration with audio + subtitles', async () => {
    const sb = makeSampleStoryboard();
    await saveStoryboard(projectPath, sb);

    const result = await generateNarration(
      {
        projectPath,
        sceneId: 'scene-01',
        engine: 'fake',
        voice: 'alice',
        speed: 1.0,
      },
      tts,
    );

    expect(result.audioPath).toBe('narration/scene-01.mp3');
    expect(result.srtPath).toBe('narration/scene-01.srt');
    expect(result.vttPath).toBe('narration/scene-01.vtt');
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result.timingCount).toBeGreaterThan(0);
    expect(result.unsupportedEmotives).toEqual([]);

    // Audio file should exist
    const audioStat = await stat(path.join(projectPath, result.audioPath));
    expect(audioStat.size).toBeGreaterThan(0);

    // SRT file should exist and be valid
    const srt = await readFile(path.join(projectPath, result.srtPath), 'utf-8');
    expect(srt).toContain('-->');
    expect(srt).not.toContain('[warm]');

    // VTT file should exist
    const vtt = await readFile(path.join(projectPath, result.vttPath), 'utf-8');
    expect(vtt).toMatch(/^WEBVTT/);

    // Storyboard should be updated
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.audio).toBe('narration/scene-01.mp3');
    expect(scene?.narration?.subtitles?.srt).toBe('narration/scene-01.srt');
    expect(scene?.narration?.tts?.engine).toBe('fake');
    expect(scene?.narration?.tts?.voice).toBe('alice');
    expect(scene?.narration?.timings?.length).toBeGreaterThan(0);
  });

  it('throws when scene has no script', async () => {
    const sb = makeSampleStoryboard();
    await saveStoryboard(projectPath, sb);

    await expect(
      generateNarration(
        { projectPath, sceneId: 'scene-02', engine: 'fake', voice: 'alice' },
        tts,
      ),
    ).rejects.toThrow('no script');
  });

  it('throws for nonexistent scene', async () => {
    const sb = makeSampleStoryboard();
    await saveStoryboard(projectPath, sb);

    await expect(
      generateNarration(
        { projectPath, sceneId: 'no-such', engine: 'fake', voice: 'alice' },
        tts,
      ),
    ).rejects.toThrow('Scene not found');
  });

  it('throws when no storyboard exists', async () => {
    await expect(
      generateNarration(
        { projectPath, sceneId: 'scene-01', engine: 'fake', voice: 'alice' },
        tts,
      ),
    ).rejects.toThrow('No storyboard found');
  });

  it('reports unsupported emotive tags', async () => {
    const sb = makeSampleStoryboard();
    sb.scenes[0]!.narration = {
      script: '[warm] Hello [alien-vibe] world [robotic] test',
    };
    await saveStoryboard(projectPath, sb);

    const result = await generateNarration(
      { projectPath, sceneId: 'scene-01', engine: 'fake', voice: 'alice' },
      tts,
    );

    expect(result.unsupportedEmotives).toContain('alien-vibe');
    expect(result.unsupportedEmotives).toContain('robotic');
    expect(result.unsupportedEmotives).not.toContain('warm');
  });
});
