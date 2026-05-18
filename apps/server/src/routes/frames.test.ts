import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { __clearFrameManifestCache } from '../services/frame/manifest.js';
import { registerFramesRoutes } from './frames.js';

// A minimal 1x1 PNG in binary (smallest valid PNG)
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
  '2e00000000c49444154789c6260f8cfc00000000200019e221bc330000000049454e44ae426082',
  'hex',
);

async function buildTestAssets(assetsDir: string, frames: object[]) {
  await mkdir(path.join(assetsDir, 'frames'), { recursive: true });
  await mkdir(path.join(assetsDir, 'thumbnails'), { recursive: true });

  const manifest = { version: 1, frames };
  await writeFile(
    path.join(assetsDir, 'manifest.json'),
    JSON.stringify(manifest),
    'utf-8',
  );
}

async function buildTestServer(assetsDir: string) {
  const app = Fastify();
  await app.register(async (instance) => registerFramesRoutes(instance, { assetsDir }));
  return app;
}

describe('frames routes', () => {
  let assetsDir: string;

  beforeEach(async () => {
    __clearFrameManifestCache();
    assetsDir = await mkdtemp(path.join(tmpdir(), 'vpa-frames-routes-'));
  });

  afterEach(async () => {
    await rm(assetsDir, { recursive: true, force: true });
  });

  describe('GET /api/frames', () => {
    it('returns a JSON array of frame entries without filesystem paths', async () => {
      await buildTestAssets(assetsDir, [
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
      ]);
      const app = await buildTestServer(assetsDir);

      try {
        const res = await app.inject({ method: 'GET', url: '/api/frames' });
        expect(res.statusCode).toBe(200);
        const body = res.json();

        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(1);

        const entry = body[0];
        // Required public fields
        expect(entry).toHaveProperty('id', 'laptop-flat');
        expect(entry).toHaveProperty('family', 'laptop');
        expect(entry).toHaveProperty('variant', 'flat');
        expect(entry).toHaveProperty('displayName', 'MacBook (flat)');
        expect(entry).toHaveProperty('type', 'flat');
        expect(entry).toHaveProperty('thumbnailUrl', '/api/frames/laptop-flat/thumbnail');

        // No filesystem paths leaked
        expect(entry).not.toHaveProperty('frame');
        expect(entry).not.toHaveProperty('thumbnail');
        expect(entry).not.toHaveProperty('frameSize');
        expect(entry).not.toHaveProperty('inset');
        expect(entry).not.toHaveProperty('quad');
      } finally {
        await app.close();
      }
    });

    it('encodes special characters in thumbnailUrl', async () => {
      await buildTestAssets(assetsDir, [
        {
          id: 'phone flat',
          family: 'phone',
          variant: 'flat',
          displayName: 'Phone (flat)',
          frame: 'frames/phone-flat.png',
          thumbnail: 'thumbnails/phone-flat.png',
          frameSize: { w: 390, h: 844 },
          type: 'flat',
          inset: { x: 20, y: 80, w: 350, h: 690 },
        },
      ]);
      const app = await buildTestServer(assetsDir);

      try {
        const res = await app.inject({ method: 'GET', url: '/api/frames' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body[0].thumbnailUrl).toBe('/api/frames/phone%20flat/thumbnail');
      } finally {
        await app.close();
      }
    });

    it('returns multiple entries', async () => {
      await buildTestAssets(assetsDir, [
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
      ]);
      const app = await buildTestServer(assetsDir);

      try {
        const res = await app.inject({ method: 'GET', url: '/api/frames' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveLength(2);
        expect(body.map((e: { id: string }) => e.id)).toEqual([
          'laptop-flat',
          'laptop-perspective',
        ]);
      } finally {
        await app.close();
      }
    });
  });

  describe('GET /api/frames/:id/thumbnail', () => {
    beforeEach(async () => {
      await buildTestAssets(assetsDir, [
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
      ]);
      // Write a minimal PNG thumbnail
      await writeFile(
        path.join(assetsDir, 'thumbnails', 'laptop-flat.png'),
        MINIMAL_PNG,
      );
    });

    it('returns 200 with image/png content type and non-empty body', async () => {
      const app = await buildTestServer(assetsDir);

      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/frames/laptop-flat/thumbnail',
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
        expect(res.rawPayload.length).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });

    it('returns correct content-length matching actual file size', async () => {
      const app = await buildTestServer(assetsDir);

      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/frames/laptop-flat/thumbnail',
        });
        expect(res.statusCode).toBe(200);
        expect(Number(res.headers['content-length'])).toBe(MINIMAL_PNG.length);
      } finally {
        await app.close();
      }
    });

    it('returns 404 with code not_found for unknown id', async () => {
      const app = await buildTestServer(assetsDir);

      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/frames/nonsense/thumbnail',
        });
        expect(res.statusCode).toBe(404);
        const body = res.json();
        expect(body).toHaveProperty('error');
        expect(body).toHaveProperty('code', 'not_found');
      } finally {
        await app.close();
      }
    });

    it('returns 404 with code not_found when thumbnail file is missing from disk', async () => {
      // Manifest references thumbnail but the file does not exist on disk
      await buildTestAssets(assetsDir, [
        {
          id: 'laptop-missing',
          family: 'laptop',
          variant: 'flat',
          displayName: 'MacBook (missing thumb)',
          frame: 'frames/laptop-flat.png',
          thumbnail: 'thumbnails/laptop-missing.png',
          frameSize: { w: 1920, h: 1200 },
          type: 'flat',
          inset: { x: 80, y: 80, w: 1760, h: 1100 },
        },
      ]);
      // Intentionally NOT writing the thumbnail file
      const app = await buildTestServer(assetsDir);

      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/frames/laptop-missing/thumbnail',
        });
        expect(res.statusCode).toBe(404);
        const body = res.json();
        expect(body).toHaveProperty('code', 'not_found');
      } finally {
        await app.close();
      }
    });
  });
});
