import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project, Scene, Storyboard } from '@vpa/shared';
import { dumpYaml } from '../../lib/yaml.js';
import {
  loadStoryboard,
  saveStoryboard,
  createStoryboard,
  addScene,
  updateScene,
  removeScene,
  reorderScenes,
} from './index.js';

const testProject: Project = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'test-project',
  path: '/tmp/test',
  created: '2026-04-30T00:00:00.000Z',
  objective: 'Test objective',
  brand: null,
};

const scene1: Scene = {
  id: 'scene-01',
  name: 'Setup',
  description: 'Show setup',
  type: 'desktop',
};

const scene2: Scene = {
  id: 'scene-02',
  name: 'Demo',
  description: 'Show demo',
  type: 'terminal',
};

function makeStoryboard(scenes: Scene[] = [scene1, scene2]): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: testProject.id,
      name: testProject.name,
      created: testProject.created,
      objective: testProject.objective,
    },
    scenes,
  };
}

describe('storyboard service', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vpa-storyboard-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ---- loadStoryboard ----

  describe('loadStoryboard', () => {
    it('returns null for missing file', async () => {
      const result = await loadStoryboard(dir);
      expect(result).toBeNull();
    });

    it('parses valid YAML', async () => {
      const sb = makeStoryboard();
      const yamlText = dumpYaml(sb);
      await writeFile(path.join(dir, 'storyboard.yaml'), yamlText, 'utf8');

      const loaded = await loadStoryboard(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.schema_version).toBe(1);
      expect(loaded!.project.id).toBe(testProject.id);
      expect(loaded!.scenes).toHaveLength(2);
      expect(loaded!.scenes[0]!.id).toBe('scene-01');
      expect(loaded!.scenes[1]!.id).toBe('scene-02');
    });
  });

  // ---- saveStoryboard ----

  describe('saveStoryboard', () => {
    it('writes YAML that can be loaded back', async () => {
      const sb = makeStoryboard();
      await saveStoryboard(dir, sb);

      const loaded = await loadStoryboard(dir);
      expect(loaded).toEqual(sb);
    });
  });

  // ---- createStoryboard ----

  describe('createStoryboard', () => {
    it('builds valid storyboard from project + scenes', () => {
      const sb = createStoryboard(testProject, [scene1, scene2]);
      expect(sb.schema_version).toBe(1);
      expect(sb.project.id).toBe(testProject.id);
      expect(sb.project.name).toBe(testProject.name);
      expect(sb.project.created).toBe(testProject.created);
      expect(sb.project.objective).toBe(testProject.objective);
      expect(sb.scenes).toHaveLength(2);
      expect(sb.scenes[0]).toEqual(scene1);
      expect(sb.scenes[1]).toEqual(scene2);
    });

    it('creates storyboard with empty scenes array', () => {
      const sb = createStoryboard(testProject, []);
      expect(sb.scenes).toHaveLength(0);
    });
  });

  // ---- addScene ----

  describe('addScene', () => {
    it('adds a scene', () => {
      const sb = makeStoryboard([scene1]);
      const result = addScene(sb, scene2);
      expect(result.scenes).toHaveLength(2);
      expect(result.scenes[1]).toEqual(scene2);
    });

    it('rejects duplicate id', () => {
      const sb = makeStoryboard([scene1]);
      expect(() => addScene(sb, scene1)).toThrow(/already exists/);
    });

    it('does not mutate original storyboard', () => {
      const sb = makeStoryboard([scene1]);
      addScene(sb, scene2);
      expect(sb.scenes).toHaveLength(1);
    });
  });

  // ---- updateScene ----

  describe('updateScene', () => {
    it('updates scene fields', () => {
      const sb = makeStoryboard();
      const result = updateScene(sb, 'scene-01', { name: 'Updated Setup' });
      expect(result.scenes[0]!.name).toBe('Updated Setup');
      expect(result.scenes[0]!.description).toBe('Show setup');
      expect(result.scenes[0]!.id).toBe('scene-01');
    });

    it('preserves id even if patch contains different id', () => {
      const sb = makeStoryboard();
      const result = updateScene(sb, 'scene-01', {
        id: 'should-be-ignored',
        name: 'New name',
      });
      expect(result.scenes[0]!.id).toBe('scene-01');
    });

    it('rejects unknown id', () => {
      const sb = makeStoryboard();
      expect(() => updateScene(sb, 'no-such-scene', { name: 'X' })).toThrow(
        /Scene not found/,
      );
    });

    it('does not mutate original storyboard', () => {
      const sb = makeStoryboard();
      updateScene(sb, 'scene-01', { name: 'Updated' });
      expect(sb.scenes[0]!.name).toBe('Setup');
    });
  });

  // ---- removeScene ----

  describe('removeScene', () => {
    it('removes scene', () => {
      const sb = makeStoryboard();
      const result = removeScene(sb, 'scene-01');
      expect(result.scenes).toHaveLength(1);
      expect(result.scenes[0]!.id).toBe('scene-02');
    });

    it('rejects unknown id', () => {
      const sb = makeStoryboard();
      expect(() => removeScene(sb, 'no-such-scene')).toThrow(
        /Scene not found/,
      );
    });

    it('does not mutate original storyboard', () => {
      const sb = makeStoryboard();
      removeScene(sb, 'scene-01');
      expect(sb.scenes).toHaveLength(2);
    });
  });

  // ---- reorderScenes ----

  describe('reorderScenes', () => {
    it('reorders scenes', () => {
      const sb = makeStoryboard();
      const result = reorderScenes(sb, ['scene-02', 'scene-01']);
      expect(result.scenes[0]!.id).toBe('scene-02');
      expect(result.scenes[1]!.id).toBe('scene-01');
    });

    it('rejects missing ids', () => {
      const sb = makeStoryboard();
      expect(() => reorderScenes(sb, ['scene-01', 'no-such'])).toThrow(
        /Scene not found in reorder list/,
      );
    });

    it('rejects incomplete list (missing scene)', () => {
      const sb = makeStoryboard();
      expect(() => reorderScenes(sb, ['scene-01'])).toThrow(
        /must include all scene ids/,
      );
    });

    it('does not mutate original storyboard', () => {
      const sb = makeStoryboard();
      reorderScenes(sb, ['scene-02', 'scene-01']);
      expect(sb.scenes[0]!.id).toBe('scene-01');
    });
  });
});
