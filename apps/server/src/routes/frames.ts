import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadFrameManifest,
  defaultAssetsDir,
  getFrame,
} from '../services/frame/manifest.js';

interface Deps {
  /** Optional override of the assets directory. Defaults to defaultAssetsDir(). */
  assetsDir?: string;
}

export async function registerFramesRoutes(app: FastifyInstance, deps: Deps = {}): Promise<void> {
  const assetsDir = deps.assetsDir ?? defaultAssetsDir();

  // GET /api/frames — enumerate
  app.get('/api/frames', async () => {
    const manifest = await loadFrameManifest(assetsDir);
    return manifest.frames.map((f) => ({
      id: f.id,
      family: f.family,
      variant: f.variant,
      displayName: f.displayName,
      type: f.type,
      thumbnailUrl: `/api/frames/${encodeURIComponent(f.id)}/thumbnail`,
    }));
  });

  // GET /api/frames/:id/thumbnail — stream PNG
  app.get<{ Params: { id: string } }>('/api/frames/:id/thumbnail', async (req, reply) => {
    const { id } = req.params;
    const manifest = await loadFrameManifest(assetsDir);
    const entry = getFrame(manifest, id);
    if (!entry) {
      return reply.status(404).send({ error: `Frame not found: ${id}`, code: 'not_found' });
    }
    const thumbnailPath = join(assetsDir, entry.thumbnail);
    const fileStat = await stat(thumbnailPath).catch(() => null);
    if (!fileStat) {
      return reply.status(404).send({ error: `Thumbnail file missing for: ${id}`, code: 'not_found' });
    }
    reply.header('Content-Type', 'image/png');
    reply.header('Content-Length', fileStat.size);
    reply.header('Cache-Control', 'public, max-age=86400'); // 1 day — thumbnails rarely change
    return reply.send(createReadStream(thumbnailPath));
  });
}
