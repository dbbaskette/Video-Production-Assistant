import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeOverlayRenderer } from './render.js';
import type { LowerThird } from '@vpa/shared';

const SCENE_ID = '00000000-0000-4000-8000-000000000001';

const sampleLowerThirds: LowerThird[] = [
  {
    title: 'John Doe',
    subtitle: 'Software Engineer',
    style: 'frosted',
    in_sec: 2,
    out_sec: 7,
  },
  {
    title: 'Feature Demo',
    style: 'solid',
    in_sec: 10,
    out_sec: 15,
  },
];

describe('overlay render', () => {
  let projectRoot: string;
  let sourceFile: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'vpa-overlay-'));
    sourceFile = path.join(projectRoot, 'source.mp4');
    await writeFile(sourceFile, 'fake-mp4-data');
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe('createFakeOverlayRenderer', () => {
    it('produces an output file', async () => {
      const render = createFakeOverlayRenderer();
      const result = await render({
        projectPath: projectRoot,
        sceneId: SCENE_ID,
        recordingPath: sourceFile,
        lowerThirds: sampleLowerThirds,
      });

      const outputAbsolute = path.join(projectRoot, result.outputPath);
      const s = await stat(outputAbsolute);
      expect(s.isFile()).toBe(true);
    });

    it('returns correct output path', async () => {
      const render = createFakeOverlayRenderer();
      const result = await render({
        projectPath: projectRoot,
        sceneId: SCENE_ID,
        recordingPath: sourceFile,
        lowerThirds: sampleLowerThirds,
      });

      expect(result.outputPath).toBe(`overlays/${SCENE_ID}-lower-thirds.mp4`);
    });

    it('returns a duration', async () => {
      const render = createFakeOverlayRenderer();
      const result = await render({
        projectPath: projectRoot,
        sceneId: SCENE_ID,
        recordingPath: sourceFile,
        lowerThirds: sampleLowerThirds,
      });

      expect(result.durationSec).toBe(47.2);
    });

    it('creates overlays directory if missing', async () => {
      const render = createFakeOverlayRenderer();
      await render({
        projectPath: projectRoot,
        sceneId: SCENE_ID,
        recordingPath: sourceFile,
        lowerThirds: sampleLowerThirds,
      });

      const overlaysDir = path.join(projectRoot, 'overlays');
      const s = await stat(overlaysDir);
      expect(s.isDirectory()).toBe(true);
    });
  });
});
