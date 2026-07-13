import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TtsService, createFakeTtsProvider } from '../tts/index.js';
import { createFakeLlm } from '../llm/index.js';
import { saveStoryboard, loadStoryboard } from '../storyboard/index.js';
import { generateNarration, generateAllChunks, splitScriptIntoChunks } from './index.js';
import type { Storyboard } from '@vpa/shared';

// The `fake` TTS engine never routes through the xAI expressiveness pass, so
// this LLM is never actually called — it just satisfies the signature.
const fakeLlm = createFakeLlm();
function wsRoot(): string {
  return path.resolve(import.meta.dirname, '../../../../..');
}

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
      fakeLlm,
      wsRoot(),
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

  it('persists the requested expressiveness level on the scene', async () => {
    const sb = makeSampleStoryboard();
    await saveStoryboard(projectPath, sb);

    await generateNarration(
      { projectPath, sceneId: 'scene-01', engine: 'fake', voice: 'alice', expressiveness: 'heavy' },
      tts,
      fakeLlm,
      wsRoot(),
    );

    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.tts?.expressiveness).toBe('heavy');
  });

  it('falls back to the project default level when none is requested', async () => {
    const sb = makeSampleStoryboard();
    sb.defaults = { tts_expressiveness: 'light' };
    await saveStoryboard(projectPath, sb);

    await generateNarration(
      { projectPath, sceneId: 'scene-01', engine: 'fake', voice: 'alice' },
      tts,
      fakeLlm,
      wsRoot(),
    );

    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.tts?.expressiveness).toBe('light');
  });

  it('stores gapSec on chunks from [pause] tokens in the script', async () => {
    const sb = makeSampleStoryboard();
    sb.scenes[0]!.narration = { script: 'First line. [pause 1.5s] Second line.' };
    await saveStoryboard(projectPath, sb);

    await generateAllChunks(
      { projectPath, sceneId: 'scene-01', engine: 'fake', voice: 'alice' },
      tts,
      fakeLlm,
      wsRoot(),
      () => {},
    );

    const updated = await loadStoryboard(projectPath);
    const chunks = updated!.scenes.find((s) => s.id === 'scene-01')!.narration!.chunks!;
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe('First line.'); // token stripped
    expect(chunks[0]!.gapSec).toBe(1.5);
    expect(chunks[1]!.gapSec ?? 0).toBe(0);
  });

  it('throws when scene has no script', async () => {
    const sb = makeSampleStoryboard();
    await saveStoryboard(projectPath, sb);

    await expect(
      generateNarration(
        { projectPath, sceneId: 'scene-02', engine: 'fake', voice: 'alice' },
        tts,
        fakeLlm,
        wsRoot(),
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
        fakeLlm,
        wsRoot(),
      ),
    ).rejects.toThrow('Scene not found');
  });

  it('throws when no storyboard exists', async () => {
    await expect(
      generateNarration(
        { projectPath, sceneId: 'scene-01', engine: 'fake', voice: 'alice' },
        tts,
        fakeLlm,
        wsRoot(),
      ),
    ).rejects.toThrow('No storyboard found');
  });

  it("'missing' selector regenerates chunks whose stored text drifted from the script", async () => {
    // Repro of a real bug: user regenerates the script, then clicks Generate
    // All. The default 'missing' selector originally only checked
    // !chunk.audio, so chunks left over from the previous script (with stale
    // audio paths) were silently skipped — leaving a per-scene render with
    // narration that didn't match the new script.
    const sb = makeSampleStoryboard();
    // Pretend the user previously generated chunks for an old script. The
    // chunks reference audio files that "exist" and have OLD text.
    sb.scenes[0]!.narration = {
      script:
        '[warm] This is the NEW first paragraph after a regen.\n\n[confident] And the NEW second paragraph.',
      chunks: [
        {
          index: 0,
          text: '[warm] OLD first paragraph that no longer matches the script.',
          audio: 'narration/scene-01-chunk-00.mp3',
          durationSec: 5,
        },
        {
          index: 1,
          text: '[confident] And the NEW second paragraph.', // unchanged
          audio: 'narration/scene-01-chunk-01.mp3',
          durationSec: 4,
        },
      ],
    };
    await saveStoryboard(projectPath, sb);

    const result = await generateAllChunks(
      { projectPath, sceneId: 'scene-01', engine: 'fake', voice: 'alice' },
      tts,
      fakeLlm,
      wsRoot(),
      () => {},
    );

    // Only chunk 0 should have been regenerated (text drifted); chunk 1 was
    // unchanged so 'missing' should skip it.
    expect(result.total).toBe(1);
    expect(result.completed).toBe(1);

    // Storyboard should reflect the new text on chunk 0.
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.chunks?.[0]?.text).toBe(
      '[warm] This is the NEW first paragraph after a regen.',
    );
  });

  it('splitScriptIntoChunks: standalone [pause] line, mid-paragraph split, and gapless', () => {
    expect(splitScriptIntoChunks('First para.\n\n[pause 2s]\n\nSecond para.', false)).toEqual([
      { text: 'First para.', gapSec: 2 },
      { text: 'Second para.', gapSec: 0 },
    ]);
    expect(splitScriptIntoChunks('One [pause 1s] two.', false)).toEqual([
      { text: 'One', gapSec: 1 },
      { text: 'two.', gapSec: 0 },
    ]);
    expect(splitScriptIntoChunks('A.\n\nB.', false)).toEqual([
      { text: 'A.', gapSec: 0 },
      { text: 'B.', gapSec: 0 },
    ]);
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
      fakeLlm,
      wsRoot(),
    );

    expect(result.unsupportedEmotives).toContain('alien-vibe');
    expect(result.unsupportedEmotives).toContain('robotic');
    expect(result.unsupportedEmotives).not.toContain('warm');
  });
});
