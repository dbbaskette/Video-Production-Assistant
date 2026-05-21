import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import { renderFinalVideo, RenderError, type RenderOptions } from '../services/render/index.js';
import { jobQueue } from '../lib/job-queue.js';
import { resolveTrackAudioPath, readMusicTrack } from './music.js';
import { readBrand } from '../services/brand/store.js';
import { brandPaths } from '../services/brand/paths.js';

interface Deps {
  store: ProjectStore;
  vpaHome: string;
  workspaceRoot: string;
  registryFile: string;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerRenderRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;

  // POST /api/projects/:id/render — start a render job. Returns the jobId
  // immediately; client subscribes to /api/jobs/:jobId/stream for progress.
  app.post('/api/projects/:id/render', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Partial<RenderOptions> & {
      musicTrackId?: string | null;
      musicVolumeDb?: number;
      /** When false, ignore the brand's bumper_intro / bumper_outro on this render. */
      useBrandBumpers?: boolean;
      /** When false, ignore the brand's default_music_track on this render even
       *  if the project has no explicit music selected. */
      useBrandMusic?: boolean;
    };
    const opts: RenderOptions = {
      audioMode: body.audioMode === 'mix' ? 'mix' : 'replace',
      burnSubtitles: !!body.burnSubtitles,
      // Default to true (existing behaviour) when the caller doesn't send the
      // flag. Only treat an explicit `false` as opting out.
      includeNarration: body.includeNarration !== false,
      includeLowerThirds: body.includeLowerThirds !== false,
      vpaHome: deps.vpaHome,
      workspaceRoot: deps.workspaceRoot,
    };

    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? 'Project lookup failed', code: 'not_found' });
    }

    // Resolve the project's brand so we can pull bumpers / default music. The
    // brand link is stored on project.yaml as `brand: { id, applied_version }`;
    // null means no brand assigned and we skip this whole block.
    let brandAudio: {
      bumper_intro?: string | null;
      bumper_outro?: string | null;
      default_music_track?: string | null;
    } | null = null;
    let brandSlug: string | null = null;
    // Build brandPaths the SAME way server.ts does — both args are vpaHome.
    // Brand assets live under `~/.vpa/brands/<slug>/`, NOT under the monorepo
    // `workspaceRoot`. Passing workspaceRoot here was a stale-cargo bug: it
    // made `paths.designMd(slug)` resolve to a non-existent path, so
    // `readBrand` threw, the try/catch swallowed it, and brandAudio stayed
    // null — silently dropping every brand bumper / default-music ever set.
    const bPaths = brandPaths(deps.vpaHome, deps.vpaHome);
    try {
      const project = await store.readProject(id);
      brandSlug = project.brand?.id ?? null;
      if (brandSlug) {
        const brand = await readBrand(bPaths, deps.registryFile, brandSlug);
        const audio = brand.doc.frontMatter.vpa?.audio as
          | { bumper_intro?: string | null; bumper_outro?: string | null; default_music_track?: string | null }
          | undefined;
        if (audio) brandAudio = audio;
      }
    } catch (err) {
      // Brand lookup is best-effort — a missing brand shouldn't block the
      // render. Log so future "bumpers missing" reports show up in server
      // stderr instead of being completely silent (the original swallow was
      // how this exact bug went unnoticed).
      app.log.warn({ err, projectId: id, brandSlug }, 'render: brand lookup failed');
      brandAudio = null;
    }

    // Resolve bumpers from brand (if any). Skip silently if the file referenced
    // by the front-matter no longer exists on disk — keeps the render robust
    // when assets are renamed/deleted.
    const resolveBrandAsset = (relPath: string | null | undefined): string | null => {
      if (!relPath || !brandSlug) return null;
      // brandPaths.assetsDir(slug) already gives us `vpaHome/brands/<slug>/assets`.
      // The front-matter stores paths as `assets/foo.mp4`, so we drop the
      // leading `assets/` and join under the canonical assets dir. Falls back
      // to brandDir if some legacy front-matter omits the prefix.
      const stripped = relPath.replace(/^assets\//, '');
      const abs = join(bPaths.brandDir(brandSlug), 'assets', stripped);
      return existsSync(abs) ? abs : null;
    };
    // Both flags default to true (current behaviour: brand assets auto-apply
    // when the project is linked to a brand). Setting either to `false`
    // suppresses that asset for this render only.
    const useBrandBumpers = body.useBrandBumpers !== false;
    const useBrandMusic = body.useBrandMusic !== false;

    const bumperIntroPath = useBrandBumpers ? resolveBrandAsset(brandAudio?.bumper_intro) : null;
    const bumperOutroPath = useBrandBumpers ? resolveBrandAsset(brandAudio?.bumper_outro) : null;
    if (bumperIntroPath || bumperOutroPath) {
      opts.bumperIntro = bumperIntroPath ?? undefined;
      opts.bumperOutro = bumperOutroPath ?? undefined;
    }

    // Resolve the music track. Precedence:
    //   1. Project-level track explicitly picked in the Render UI (musicTrackId).
    //   2. Brand-level default_music_track if the project hasn't chosen one.
    //   3. No background music.
    if (body.musicTrackId) {
      const track = await readMusicTrack(projectPath, body.musicTrackId);
      if (!track) {
        return reply.status(400).send({
          error: `Music track not found: ${body.musicTrackId}`,
          code: 'invalid_request',
        });
      }
      opts.music = {
        audioPath: resolveTrackAudioPath(projectPath, track),
        volumeDb: typeof body.musicVolumeDb === 'number' ? body.musicVolumeDb : -20,
      };
    } else if (useBrandMusic) {
      const brandMusic = resolveBrandAsset(brandAudio?.default_music_track);
      if (brandMusic) {
        opts.music = {
          audioPath: brandMusic,
          volumeDb: typeof body.musicVolumeDb === 'number' ? body.musicVolumeDb : -20,
        };
      }
    }

    const job = jobQueue.create('render');
    jobQueue.setStatus(job.id, 'running');
    jobQueue.emit(job.id, 'start', { projectId: id, opts });

    void (async () => {
      try {
        const result = await renderFinalVideo(projectPath, opts, (event) => {
          jobQueue.emit(job.id, 'progress', event);
        });
        jobQueue.complete(job.id, {
          projectId: id,
          outputPath: result.outputPath,
          durationSec: result.durationSec,
          sceneCount: result.scenePaths.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const hint = err instanceof RenderError ? err.hint : undefined;
        jobQueue.fail(job.id, hint ? `${message} — ${hint}` : message);
      }
    })();

    return { jobId: job.id, status: 'running' };
  });

  // GET /api/projects/:id/render/video — stream the rendered final.mp4 with Range.
  //
  // Pass `?download=1` (and optionally `?filename=My-Demo.mp4`) to flip the
  // Content-Disposition header to `attachment`, which makes browsers save the
  // file instead of rendering it inline. The HTML `download` attribute alone
  // is ignored across origins (web on :5173, API on :3000), so we set the
  // header server-side.
  app.get('/api/projects/:id/render/video', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = (req.query ?? {}) as { download?: string; filename?: string };
    const asAttachment = query.download === '1' || query.download === 'true';
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }

    const filePath = join(projectPath, 'renders', 'final.mp4');
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return reply.status(404).send({ error: 'No rendered final.mp4 — render the project first', code: 'no_render' });
    }

    const total = fileStat.size;
    const range = req.headers.range;
    const ext = extname(filePath).toLowerCase();
    const mime = ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';

    // Sanitise filename — keep alphanumerics, dash, underscore, dot. Anything
    // else is replaced with `-` so it can't break the Content-Disposition
    // header. Defaults to "final.mp4" when the caller doesn't provide one.
    const rawName = (query.filename ?? 'final.mp4').slice(0, 200);
    const safeName = rawName.replace(/[^A-Za-z0-9._-]+/g, '-') || 'final.mp4';
    if (asAttachment) {
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    }

    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        reply.header('Content-Range', `bytes */${total}`);
        return reply.status(416).send();
      }
      const start = Number.parseInt(m[1]!, 10);
      const end = m[2] && m[2].length > 0 ? Number.parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        reply.header('Content-Range', `bytes */${total}`);
        return reply.status(416).send();
      }
      reply.code(206);
      reply.header('Content-Type', mime);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Type', mime);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', total);
    return reply.send(createReadStream(filePath));
  });

  // GET /api/projects/:id/render/status — quick check whether a final.mp4 exists
  app.get('/api/projects/:id/render/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }
    const filePath = join(projectPath, 'renders', 'final.mp4');
    try {
      const s = await stat(filePath);
      return { exists: true, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
    } catch {
      return { exists: false };
    }
  });
}
