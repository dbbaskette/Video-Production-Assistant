import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadFrameManifest,
  getFrame,
  FrameEntrySchema,
} from './manifest.js';

describe('frame manifest', () => {
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(path.join(tmpdir(), 'vpa-frames-'));
    await mkdir(path.join(assetsDir, 'frames'), { recursive: true });
    await mkdir(path.join(assetsDir, 'thumbnails'), { recursive: true });
  });

  afterEach(async () => {
    await rm(assetsDir, { recursive: true, force: true });
  });

  // ── Schema unit tests ─────────────────────────────────────────

  describe('FrameEntrySchema', () => {
    it('parses a valid flat entry', () => {
      const raw = {
        id: 'laptop-flat',
        family: 'laptop',
        variant: 'flat',
        displayName: 'MacBook (flat)',
        frame: 'frames/laptop-flat.png',
        thumbnail: 'thumbnails/laptop-flat.png',
        frameSize: { w: 1920, h: 1200 },
        type: 'flat',
        inset: { x: 80, y: 80, w: 1760, h: 1100 },
      };
      const result = FrameEntrySchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('flat');
        expect(result.data.id).toBe('laptop-flat');
      }
    });

    it('parses a valid perspective entry', () => {
      const raw = {
        id: 'laptop-perspective',
        family: 'laptop',
        variant: 'perspective',
        displayName: 'MacBook (perspective)',
        frame: 'frames/laptop-perspective.png',
        thumbnail: 'thumbnails/laptop-perspective.png',
        frameSize: { w: 2000, h: 1400 },
        type: 'perspective',
        quad: {
          tl: { x: 100, y: 50 },
          tr: { x: 1900, y: 100 },
          br: { x: 1850, y: 1350 },
          bl: { x: 150, y: 1300 },
        },
      };
      const result = FrameEntrySchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('perspective');
        expect(result.data.id).toBe('laptop-perspective');
      }
    });

    it('rejects a flat entry missing inset', () => {
      const raw = {
        id: 'laptop-flat',
        family: 'laptop',
        variant: 'flat',
        displayName: 'MacBook (flat)',
        frame: 'frames/laptop-flat.png',
        thumbnail: 'thumbnails/laptop-flat.png',
        frameSize: { w: 1920, h: 1200 },
        type: 'flat',
        // inset intentionally omitted
      };
      const result = FrameEntrySchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    it('rejects a perspective entry missing quad', () => {
      const raw = {
        id: 'laptop-perspective',
        family: 'laptop',
        variant: 'perspective',
        displayName: 'MacBook (perspective)',
        frame: 'frames/laptop-perspective.png',
        thumbnail: 'thumbnails/laptop-perspective.png',
        frameSize: { w: 2000, h: 1400 },
        type: 'perspective',
        // quad intentionally omitted
      };
      const result = FrameEntrySchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    it('rejects an entry with unknown type', () => {
      const raw = {
        id: 'test',
        family: 'test',
        variant: 'test',
        displayName: 'Test',
        frame: 'frames/test.png',
        thumbnail: 'thumbnails/test.png',
        frameSize: { w: 100, h: 100 },
        type: 'unknown',
      };
      const result = FrameEntrySchema.safeParse(raw);
      expect(result.success).toBe(false);
    });
  });

  // ── loadFrameManifest ─────────────────────────────────────────

  describe('loadFrameManifest', () => {
    it('loads and parses a flat entry from manifest.json', async () => {
      const manifest = {
        version: 1,
        frames: [
          {
            id: 'laptop-flat',
            family: 'laptop',
            variant: 'flat',
            displayName: 'MacBook (flat)',
            frame: 'frames/laptop-flat.png',
            thumbnail: 'thumbnails/laptop-flat.png',
            frameSize: { w: 1920, h: 1200 },
            type: 'flat',
            inset: { x: 80, y: 80, w: 1760, h: 1100 },
          },
        ],
      };
      await writeFile(
        path.join(assetsDir, 'manifest.json'),
        JSON.stringify(manifest),
        'utf-8',
      );

      const result = await loadFrameManifest(assetsDir);
      expect(result.version).toBe(1);
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]?.id).toBe('laptop-flat');
    });

    it('loads and parses a perspective entry from manifest.json', async () => {
      const manifest = {
        version: 1,
        frames: [
          {
            id: 'laptop-perspective',
            family: 'laptop',
            variant: 'perspective',
            displayName: 'MacBook (perspective)',
            frame: 'frames/laptop-perspective.png',
            thumbnail: 'thumbnails/laptop-perspective.png',
            frameSize: { w: 2000, h: 1400 },
            type: 'perspective',
            quad: {
              tl: { x: 100, y: 50 },
              tr: { x: 1900, y: 100 },
              br: { x: 1850, y: 1350 },
              bl: { x: 150, y: 1300 },
            },
          },
        ],
      };
      await writeFile(
        path.join(assetsDir, 'manifest.json'),
        JSON.stringify(manifest),
        'utf-8',
      );

      const result = await loadFrameManifest(assetsDir);
      expect(result.version).toBe(1);
      const entry = result.frames[0];
      expect(entry?.type).toBe('perspective');
    });

    it('throws if manifest.json is missing required fields', async () => {
      const badManifest = {
        version: 1,
        frames: [
          {
            id: 'broken',
            // missing everything else
          },
        ],
      };
      await writeFile(
        path.join(assetsDir, 'manifest.json'),
        JSON.stringify(badManifest),
        'utf-8',
      );

      await expect(loadFrameManifest(assetsDir)).rejects.toThrow();
    });

    it('throws if manifest.json does not exist', async () => {
      await expect(loadFrameManifest(assetsDir)).rejects.toThrow();
    });
  });

  // ── getFrame ─────────────────────────────────────────────────

  describe('getFrame', () => {
    it('returns the matching frame entry by id', async () => {
      const manifest = {
        version: 1,
        frames: [
          {
            id: 'laptop-flat',
            family: 'laptop',
            variant: 'flat',
            displayName: 'MacBook (flat)',
            frame: 'frames/laptop-flat.png',
            thumbnail: 'thumbnails/laptop-flat.png',
            frameSize: { w: 1920, h: 1200 },
            type: 'flat',
            inset: { x: 80, y: 80, w: 1760, h: 1100 },
          },
        ],
      };
      await writeFile(
        path.join(assetsDir, 'manifest.json'),
        JSON.stringify(manifest),
        'utf-8',
      );
      const loaded = await loadFrameManifest(assetsDir);
      const frame = getFrame(loaded, 'laptop-flat');
      expect(frame).toBeDefined();
      expect(frame?.id).toBe('laptop-flat');
    });

    it('returns undefined for an unknown id', async () => {
      const manifest = {
        version: 1,
        frames: [
          {
            id: 'laptop-flat',
            family: 'laptop',
            variant: 'flat',
            displayName: 'MacBook (flat)',
            frame: 'frames/laptop-flat.png',
            thumbnail: 'thumbnails/laptop-flat.png',
            frameSize: { w: 1920, h: 1200 },
            type: 'flat',
            inset: { x: 80, y: 80, w: 1760, h: 1100 },
          },
        ],
      };
      await writeFile(
        path.join(assetsDir, 'manifest.json'),
        JSON.stringify(manifest),
        'utf-8',
      );
      const loaded = await loadFrameManifest(assetsDir);
      const frame = getFrame(loaded, 'unknown-id');
      expect(frame).toBeUndefined();
    });
  });

  // ── Module-level cache ────────────────────────────────────────

  describe('caching', () => {
    it('returns the same object reference across two calls', async () => {
      const manifest = {
        version: 1,
        frames: [
          {
            id: 'laptop-flat',
            family: 'laptop',
            variant: 'flat',
            displayName: 'MacBook (flat)',
            frame: 'frames/laptop-flat.png',
            thumbnail: 'thumbnails/laptop-flat.png',
            frameSize: { w: 1920, h: 1200 },
            type: 'flat',
            inset: { x: 80, y: 80, w: 1760, h: 1100 },
          },
        ],
      };
      await writeFile(
        path.join(assetsDir, 'manifest.json'),
        JSON.stringify(manifest),
        'utf-8',
      );

      const first = await loadFrameManifest(assetsDir);
      const second = await loadFrameManifest(assetsDir);
      expect(first).toBe(second); // same object reference
    });
  });
});
