import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestRecording } from './ingest.js';
import { saveStoryboard, loadStoryboard } from '../storyboard/index.js';
import type { Storyboard } from '@vpa/shared';
import type { VideoMetadata } from './metadata.js';

const sampleMetadata: VideoMetadata = {
  duration_sec: 47.2,
  width: 1920,
  height: 1080,
  codec: 'h264',
  fps: 30,
  size_bytes: 15_000_000,
};

function makeSampleStoryboard(projectId: string): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: projectId,
      name: 'test-proj',
      created: new Date().toISOString(),
      objective: 'test',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Intro scene', type: 'desktop' },
      { id: 'scene-02', name: 'Demo', description: 'Demo scene', type: 'terminal' },
    ],
  };
}

describe('recording ingest', () => {
  let projectRoot: string;
  let sourceFile: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'vpa-ingest-'));
    sourceFile = path.join(projectRoot, 'upload.mp4');
    await writeFile(sourceFile, 'fake-mp4-data');
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('copies file to recordings directory', async () => {
    const sb = makeSampleStoryboard('a0000000-0000-4000-8000-000000000001');
    await saveStoryboard(projectRoot, sb);

    const result = await ingestRecording(projectRoot, 'scene-01', sourceFile, sampleMetadata);
    expect(result.sceneId).toBe('scene-01');
    expect(result.relativePath).toBe('recordings/scene-01.mp4');
    expect(result.metadata.duration_sec).toBe(47.2);

    const destPath = path.join(projectRoot, 'recordings', 'scene-01.mp4');
    const content = await readFile(destPath, 'utf8');
    expect(content).toBe('fake-mp4-data');
  });

  it('updates storyboard with recording info', async () => {
    const sb = makeSampleStoryboard('a0000000-0000-4000-8000-000000000002');
    await saveStoryboard(projectRoot, sb);

    await ingestRecording(projectRoot, 'scene-01', sourceFile, sampleMetadata);

    const updated = await loadStoryboard(projectRoot);
    expect(updated).not.toBeNull();
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.recording?.source).toBe('recordings/scene-01.mp4');
    expect(scene?.recording?.duration_sec).toBe(47.2);
    expect(scene?.recording?.ingested_at).toBeTruthy();
  });

  it('creates recordings directory if missing', async () => {
    const sb = makeSampleStoryboard('a0000000-0000-4000-8000-000000000003');
    await saveStoryboard(projectRoot, sb);

    await ingestRecording(projectRoot, 'scene-02', sourceFile, sampleMetadata);

    const destPath = path.join(projectRoot, 'recordings', 'scene-02.mp4');
    const s = await stat(destPath);
    expect(s.isFile()).toBe(true);
  });

  it('works without existing storyboard', async () => {
    const result = await ingestRecording(projectRoot, 'scene-01', sourceFile, sampleMetadata);
    expect(result.sceneId).toBe('scene-01');

    const destPath = path.join(projectRoot, 'recordings', 'scene-01.mp4');
    const content = await readFile(destPath, 'utf8');
    expect(content).toBe('fake-mp4-data');
  });
});
