import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { copyFile, readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import { renderFinalVideo, probeAudioParams, probeVideoSize, runFfmpeg, type RenderOptions } from '../services/render/index.js';
import { privateRenderDiagnostic, publicRenderFailure } from '../services/render/errors.js';
import { buildTransitionClip } from '../services/render/transition-clip.js';
import { jobQueue } from '../lib/job-queue.js';
import { snapshotProjectJobInput } from '../services/jobs/frozen-input.js';
import { resolveTrackAudioPath, readMusicTrack } from './music.js';
import { readBrandVersion, validateBrandVersion } from '../services/brand/store.js';
import { brandPaths } from '../services/brand/paths.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { effectiveMixSettings, SceneTransitionSchema } from '@vpa/shared';
import { computeWorkflowStatus } from '../services/workflow-status/index.js';
import { buildRenderFingerprint } from '../services/workflow-status/fingerprint.js';
import { listRenderManifests, readRenderManifest, writeRenderManifest } from '../services/workflow-status/render-manifest.js';
import { RevisionStore } from '../services/revisions/store.js';
import { projectFiles } from '../services/project/paths.js';
import { getQualityReview } from './quality-review.js';
import { resolveSafeProjectPath } from '../services/project/safe-path.js';
import { createSubmittedJob, jobSubmissionFailure, readIdempotencyKey } from '../lib/job-submission.js';
import { VariantStore, VariantStoreError } from '../services/variants/store.js';
import { validateVariant, variantDimensions } from '../services/variants/validate.js';
import { prepareVariantSnapshot, resolveVariantNarration } from '../services/variants/prepare.js';
import type { OutputVariant } from '@vpa/shared';

interface Deps {
  store: ProjectStore;
  vpaHome: string;
  workspaceRoot: string;
  registryFile: string;
  renderVideo?: typeof renderFinalVideo;
  finalizeArtifact?: (inputPath: string, outputPath: string, quality: 'draft' | '1080p', variant?: OutputVariant | null) => Promise<{ width: number; height: number }>;
}

async function finalizeArtifact(inputPath: string, outputPath: string, quality: 'draft' | '1080p', variant?: OutputVariant | null) {
  const target = variant ? variantDimensions(variant.aspect_ratio, quality) : quality === 'draft' ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
  const filter = variant?.crop.mode === 'cover'
    ? `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height}:(iw-ow)*${variant.crop.focus_x}:(ih-oh)*${variant.crop.focus_y},fps=30`
    : `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,fps=30`;
  await runFfmpeg([
    '-y', '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', quality === 'draft' ? '26' : '20',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath,
  ]);
  return target;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerRenderRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;
  const renderVideo = deps.renderVideo ?? renderFinalVideo;
  const finalize = deps.finalizeArtifact ?? finalizeArtifact;

  // POST /api/projects/:id/render — start a render job. Returns the jobId
  // immediately; client subscribes to /api/jobs/:jobId/stream for progress.
  app.post('/api/projects/:id/render', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Partial<RenderOptions> & {
      musicTrackId?: string | null;
      musicVolumeDb?: number;
      /** 'full' (default) beds music under the whole video; 'bumpers' plays it
       *  only over the intro/outro bumper windows. */
      musicScope?: 'full' | 'bumpers';
      /** When false, ignore the brand's bumper_intro / bumper_outro on this render. */
      useBrandBumpers?: boolean;
      /** When false, ignore the brand's default_music_track on this render even
       *  if the project has no explicit music selected. */
      useBrandMusic?: boolean;
      quality?: 'draft' | '1080p';
      variantId?: string | null;
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

    const project = await store.readProject(id);
    const storyboard = await loadStoryboard(projectPath);
    const workflow = await computeWorkflowStatus({
      projectPath,
      project,
      storyboard,
      review: getQualityReview(id),
    });
    if (!workflow.render.ready) {
      return reply.status(409).send({
        error: 'The project is not ready for a full render.',
        code: 'render_blocked',
        blockers: workflow.render.blockers,
      });
    }

    let variant: OutputVariant | null = null;
    if (body.variantId) {
      try {
        variant = await new VariantStore(projectPath).get(body.variantId);
      } catch (error) {
        const code = error instanceof VariantStoreError ? error.code : 'not_found';
        return reply.status(code === 'not_found' ? 404 : 409).send({ error: error instanceof Error ? error.message : 'Variant unavailable.', code: 'variant_not_found' });
      }
      const currentRevision = await new RevisionStore(projectPath).currentRevision();
      const validation = validateVariant(variant, storyboard!, project, currentRevision);
      if (validation.blockers.length > 0) {
        return reply.status(409).send({ error: 'The output variant needs review before rendering.', code: 'variant_blocked', blockers: validation.blockers, warnings: validation.warnings });
      }
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
      brandSlug = project.brand?.id ?? null;
      if (brandSlug) {
        const appliedVersion = project.brand!.applied_version;
        const validation = await validateBrandVersion(bPaths, deps.registryFile, brandSlug, appliedVersion);
        if (!validation.valid) {
          return reply.status(409).send({
            error: 'The pinned brand version references assets that are unavailable.',
            code: 'brand_assets_missing',
            brandId: brandSlug,
            brandVersion: appliedVersion,
            missingAssets: validation.missingAssets,
          });
        }
        const brand = await readBrandVersion(bPaths, deps.registryFile, brandSlug, appliedVersion);
        const audio = brand.doc.frontMatter.vpa?.audio as
          | { bumper_intro?: string | null; bumper_outro?: string | null; default_music_track?: string | null }
          | undefined;
        if (audio) brandAudio = audio;
      }
    } catch (err) {
      app.log.warn({ err, projectId: id, brandSlug }, 'render: brand lookup failed');
      return reply.status(409).send({
        error: 'The project\'s pinned brand version is unavailable. Choose an available version before rendering.',
        code: 'brand_version_unavailable',
      });
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

    // 'bumpers' scope only makes sense when a bumper is actually in this
    // render. Coerce to 'full' otherwise so we never emit a silent-music
    // render even if the client sends a stale value (the UI also disables the
    // option in that case).
    const hasBumper = !!(bumperIntroPath || bumperOutroPath);
    const musicScope: 'full' | 'bumpers' =
      body.musicScope === 'bumpers' && hasBumper ? 'bumpers' : 'full';
    const compositionWithMusic = storyboard?.scenes
      .find((scene) => scene.composition?.audio_mix.music)?.composition;
    const musicMix = compositionWithMusic ? effectiveMixSettings(compositionWithMusic, 'music') : null;
    const musicVolumeDb = typeof body.musicVolumeDb === 'number' ? body.musicVolumeDb : musicMix?.gain_db ?? -20;

    // Resolve the music track. Precedence:
    //   1. Project-level track explicitly picked in the Render UI (musicTrackId).
    //   2. Brand-level default_music_track if the project hasn't chosen one.
    //   3. No background music.
    if (body.musicTrackId && !musicMix?.mute) {
      const track = await readMusicTrack(projectPath, body.musicTrackId);
      if (!track) {
        return reply.status(400).send({
          error: `Music track not found: ${body.musicTrackId}`,
          code: 'invalid_request',
        });
      }
      opts.music = {
        audioPath: resolveTrackAudioPath(projectPath, track),
        volumeDb: musicVolumeDb,
        scope: musicScope,
        fadeInMs: musicMix?.fade_in_ms,
        fadeOutMs: musicMix?.fade_out_ms,
      };
    } else if (useBrandMusic && !musicMix?.mute) {
      const brandMusic = resolveBrandAsset(brandAudio?.default_music_track);
      if (brandMusic) {
        opts.music = {
          audioPath: brandMusic,
          volumeDb: musicVolumeDb,
          scope: musicScope,
          fadeInMs: musicMix?.fade_in_ms,
          fadeOutMs: musicMix?.fade_out_ms,
        };
      }
    }

    const frozenInput = await snapshotProjectJobInput(projectPath, { ...body, musicScope, variant });
    let frozenRevision;
    try {
      frozenRevision = await new RevisionStore(frozenInput.projectPath).readRevision(frozenInput.inputRevision);
    } catch (error) {
      await frozenInput.cleanup();
      throw error;
    }
    if (variant && (frozenInput.inputRevision !== variant.source_revision || JSON.stringify(frozenRevision.project.brand) !== JSON.stringify(variant.source_brand))) {
      await frozenInput.cleanup();
      return reply.status(409).send({ error: 'The project changed while this variant render was being prepared. Review and rebase the variant.', code: 'variant_stale' });
    }
    let submission;
    try {
      submission = await createSubmittedJob('render', {
        projectId: id,
        label: 'Render final video',
        ...frozenInput,
      }, readIdempotencyKey(req.headers));
    } catch (error) {
      const failure = jobSubmissionFailure(error);
      await frozenInput.cleanup();
      if (failure) return reply.status(failure.status).send(failure.body);
      throw error;
    }
    const { job } = submission;
    if (submission.reused) {
      await frozenInput.cleanup();
      return { jobId: job.id, status: job.status, reused: true };
    }
    jobQueue.setStatus(job.id, 'running');
    jobQueue.emit(job.id, 'start', { projectId: id, opts });

    // Cooperative cancellation: the generic /api/jobs/:jobId/cancel route
    // flips the job to 'cancelling'; the render pipeline polls this at safe
    // boundaries (between scenes, before concat) and bails.
    opts.isCancelled = () => jobQueue.get(job.id)?.status === 'cancelling';

    void (async () => {
      try {
        if (variant) await prepareVariantSnapshot(frozenInput.projectPath, variant);
        const result = await renderVideo(frozenInput.projectPath, opts, (event) => {
          jobQueue.emit(job.id, 'progress', event);
        });
        const manifestOptions = {
          audioMode: opts.audioMode,
          burnSubtitles: opts.burnSubtitles,
          includeNarration: opts.includeNarration,
          includeLowerThirds: opts.includeLowerThirds,
          musicTrackId: body.musicTrackId ?? null,
          musicVolumeDb: body.musicVolumeDb ?? -20,
          musicScope,
          useBrandBumpers,
          useBrandMusic,
          quality: body.quality ?? '1080p',
          variantId: variant?.id ?? null,
          variantDefinition: variant,
        };
        const artifactId = `render-${job.id}-r${frozenInput.inputRevision}${variant ? `-${variant.id}` : ''}`.replace(/[^A-Za-z0-9._-]/g, '-');
        const artifactRel = join('renders', 'artifacts', `${artifactId}.mp4`);
        const artifactPath = join(projectPath, artifactRel);
        await mkdir(join(projectPath, 'renders', 'artifacts'), { recursive: true });
        let finalizeInput = result.outputPath;
        if (variant) {
          const narration = await resolveVariantNarration(frozenInput.projectPath, variant);
          if (narration) {
            const localized = join(frozenInput.projectPath, '.vpa', 'variants', variant.id, 'localized-audio.mp4');
            await mkdir(join(frozenInput.projectPath, '.vpa', 'variants', variant.id), { recursive: true });
            await runFfmpeg(['-y', '-i', result.outputPath, '-i', narration, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', localized]);
            finalizeInput = localized;
          }
        }
        const target = await finalize(finalizeInput, artifactPath, body.quality ?? '1080p', variant);
        // Compatibility pointer for older clients. Prior outputs remain under
        // their immutable artifact paths and are never overwritten.
        if (!variant) await copyFile(artifactPath, join(projectPath, 'renders', 'final.mp4'));
        const outputInfo = await stat(artifactPath);
        const assetManifest = await readFile(projectFiles(frozenInput.projectPath).assetManifest, 'utf8').then((raw) => JSON.parse(raw) as { assets?: Array<{ id: string; checksum: string }> }).catch(() => ({ assets: [] }));
        await writeRenderManifest(projectPath, {
          artifactId,
          jobId: job.id,
          revision: frozenInput.inputRevision,
          inputFingerprint: frozenInput.inputFingerprint,
          sourceChecksums: Object.fromEntries((assetManifest.assets ?? []).map((asset) => [asset.id, asset.checksum])),
          rendererVersion: 'vpa-renderer-2',
          fonts: [],
          completedAt: new Date().toISOString(),
          ...(variant ? { variant: { id: variant.id, name: variant.name, aspectRatio: variant.aspect_ratio, cropMode: variant.crop.mode, sourceRevision: variant.source_revision, targetLanguage: variant.target_language, localizationProvider: variant.captions[0]?.provider ?? variant.narration_replacement?.provider ?? null } } : {}),
          output: {
            path: artifactRel,
            sizeBytes: outputInfo.size,
            durationSec: result.durationSec,
            sceneCount: result.scenePaths.length,
            width: target.width,
            height: target.height,
            fps: 30,
            videoCodec: 'h264',
            audioCodec: 'aac',
          },
          options: manifestOptions,
          fingerprint: await buildRenderFingerprint(frozenInput.projectPath, frozenRevision.project, frozenRevision.storyboard, manifestOptions),
        }, { makeCurrent: !variant });
        jobQueue.complete(job.id, {
          projectId: id,
          outputPath: artifactPath,
          durationSec: result.durationSec,
          sceneCount: result.scenePaths.length,
        }, [{
          kind: 'video',
          path: artifactRel,
          revision: job.meta?.inputRevision,
          fingerprint: job.meta?.inputFingerprint,
        }]);
      } catch (err) {
        if (opts.isCancelled?.()) {
          jobQueue.finishCancelled(job.id, { projectId: id, cancelled: true });
          return;
        }
        const failure = publicRenderFailure(err, 'project');
        app.log.error(privateRenderDiagnostic(err), 'Project render failed');
        jobQueue.fail(
          job.id,
          `${failure.code}: ${failure.error}${failure.hint ? ` — ${failure.hint}` : ''}`,
        );
      } finally {
        await frozenInput.cleanup();
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
    const query = (req.query ?? {}) as { download?: string; filename?: string; artifact?: string };
    const asAttachment = query.download === '1' || query.download === 'true';
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }

    const manifests = query.artifact ? await listRenderManifests(projectPath) : [];
    const requested = query.artifact ? manifests.find((item) => item.artifactId === query.artifact) : await readRenderManifest(projectPath);
    const relativePath = requested?.output.path ?? 'renders/final.mp4';
    const filePath = await resolveSafeProjectPath(projectPath, relativePath);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return reply.status(404).send({ error: 'No rendered artifact — render the project first', code: 'no_render' });
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

  // GET /api/projects/:id/scenes/:sceneId/transition/preview
  // Build (or read from cache) the freeze-frame transition clip between
  // this scene and the next one. Same logic the final-render pipeline uses,
  // exposed standalone so users can iterate on transition style + duration
  // in ~1.5s instead of waiting for a full project render.
  app.get('/api/projects/:id/scenes/:sceneId/transition/preview', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const query = (req.query ?? {}) as { transition?: string; durationSec?: string };

    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'no_storyboard' });

    const idx = sb.scenes.findIndex((s) => s.id === sceneId);
    if (idx < 0) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    if (idx === sb.scenes.length - 1) {
      return reply.status(400).send({ error: 'Last scene — no transition to preview', code: 'last_scene' });
    }

    const from = sb.scenes[idx]!;
    const to = sb.scenes[idx + 1]!;
    if (!from.recording?.source || !to.recording?.source) {
      return reply.status(400).send({ error: 'Both scenes need a recording before a transition can be previewed', code: 'missing_recording' });
    }

    const wantedTransition = query.transition ?? from.transition ?? 'cut';
    const parsed = SceneTransitionSchema.safeParse(wantedTransition);
    if (!parsed.success) {
      return reply.status(400).send({ error: `Invalid transition: ${wantedTransition}`, code: 'invalid_transition' });
    }
    if (parsed.data === 'cut') {
      return reply.status(400).send({ error: 'Cut has no preview — it is a hard concat', code: 'cut_has_no_preview' });
    }
    const durationSec = query.durationSec
      ? Number.parseFloat(query.durationSec)
      : (from.transition_duration_sec ?? 0.5);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 5) {
      return reply.status(400).send({ error: 'durationSec must be between 0.1 and 5', code: 'invalid_duration' });
    }

    // Cache the clip under renders/.transition-previews/. Key includes
    // transition + duration so changing either invalidates the cache.
    const cacheDir = join(projectPath, 'renders', '.transition-previews');
    await mkdir(cacheDir, { recursive: true });
    const safeT = parsed.data.replace(/[^A-Za-z0-9_-]/g, '');
    const cacheFile = join(cacheDir, `${sceneId}-to-${to.id}-${safeT}-${durationSec.toFixed(2)}s.mp4`);

    if (!existsSync(cacheFile)) {
      const fromPath = await resolveSafeProjectPath(projectPath, from.recording.source);
      const toPath = await resolveSafeProjectPath(projectPath, to.recording.source);
      const [size, audio] = await Promise.all([
        probeVideoSize(fromPath),
        probeAudioParams(fromPath),
      ]);
      try {
        await buildTransitionClip({
          fromScenePath: fromPath,
          toScenePath: toPath,
          transition: parsed.data,
          durationSec,
          width: size.width || 1920,
          height: size.height || 1080,
          hasAudio: audio.sampleRate > 0,
          audioSampleRate: audio.sampleRate || 44100,
          audioChannelLayout: audio.channelLayout || (audio.channels === 1 ? 'mono' : 'stereo'),
          outputPath: cacheFile,
          tmpDir: cacheDir,
          cacheTag: `${sceneId}-${safeT}-${durationSec.toFixed(2)}`,
        });
      } catch (err) {
        const failure = publicRenderFailure(err, 'transition-preview');
        app.log.error(privateRenderDiagnostic(err), 'Transition preview render failed');
        return reply.status(500).send({
          error: failure.error,
          code: failure.code,
          ...(failure.hint ? { hint: failure.hint } : {}),
        });
      }
    }

    // Range-aware streaming so the <video> element can scrub.
    const fileStat = await stat(cacheFile);
    const total = fileStat.size;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        reply.header('Content-Range', `bytes */${total}`);
        return reply.status(416).send();
      }
      const start = Number.parseInt(m[1]!, 10);
      const end = m[2] && m[2].length > 0 ? Number.parseInt(m[2], 10) : total - 1;
      reply.code(206);
      reply.header('Content-Type', 'video/mp4');
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(createReadStream(cacheFile, { start, end }));
    }
    reply.header('Content-Type', 'video/mp4');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', total);
    return reply.send(createReadStream(cacheFile));
  });

  // GET /api/projects/:id/scenes/:sceneId/thumbnail
  // Stream a single representative frame (jpeg) of the scene's recording.
  // Used by the Render page's scene-strip so the user can glance at scene
  // ordering before kicking off a multi-minute render. Cached on disk —
  // re-extracted only when the recording's mtime is newer than the cache.
  app.get('/api/projects/:id/scenes/:sceneId/thumbnail', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const query = (req.query ?? {}) as { revision?: string };

    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }

    const requestedRevision = query.revision == null ? null : Number.parseInt(query.revision, 10);
    const sb = requestedRevision != null && Number.isInteger(requestedRevision) && requestedRevision >= 0
      ? (await new RevisionStore(projectPath).readRevision(requestedRevision)).storyboard
      : await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'no_storyboard' });
    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: 'Scene not found', code: 'scene_not_found' });
    if (!scene.recording?.source) {
      return reply.status(404).send({ error: 'No recording for this scene', code: 'no_recording' });
    }

    const recPath = await resolveSafeProjectPath(projectPath, scene.recording.source);
    const cacheDir = join(projectPath, 'renders', '.thumbnails');
    await mkdir(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, `${sceneId}${requestedRevision == null ? '' : `-r${requestedRevision}`}.jpg`);

    // Re-extract only when the recording is newer than the cached thumb.
    let needsExtract = !existsSync(cacheFile);
    if (!needsExtract) {
      try {
        const [recStat, thumbStat] = await Promise.all([stat(recPath), stat(cacheFile)]);
        if (recStat.mtimeMs > thumbStat.mtimeMs) needsExtract = true;
      } catch {
        needsExtract = true;
      }
    }
    if (needsExtract) {
      // Grab a frame ~1 second in (skips potentially-black opening
      // frames common to screen recordings). Scaled down to keep the
      // strip lightweight.
      try {
        await runFfmpeg([
          '-y',
          '-ss', String(scene.presentation_source || scene.type === 'slide' ? 0 : Math.min(1, Math.max(0, (scene.recording.duration_sec ?? 2) / 2))),
          '-i', recPath,
          '-vframes', '1',
          '-vf', 'scale=480:-2',
          '-q:v', '4',
          cacheFile,
        ]);
      } catch (err) {
        const failure = publicRenderFailure(err, 'thumbnail');
        app.log.error(privateRenderDiagnostic(err), 'Thumbnail render failed');
        return reply.status(500).send({
          error: failure.error,
          code: failure.code,
          ...(failure.hint ? { hint: failure.hint } : {}),
        });
      }
    }

    reply.header('Content-Type', 'image/jpeg');
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(createReadStream(cacheFile));
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
    try {
      const manifest = await readRenderManifest(projectPath);
      if (!manifest) return { exists: false, artifacts: await listRenderManifests(projectPath) };
      const s = await stat(await resolveSafeProjectPath(projectPath, manifest.output.path));
      const currentRevision = await new RevisionStore(projectPath).currentRevision();
      return {
        exists: true,
        sizeBytes: s.size,
        modifiedAt: s.mtime.toISOString(),
        manifest,
        currentRevision,
        stale: manifest.version === 1 ? true : manifest.revision !== currentRevision,
        artifacts: await listRenderManifests(projectPath),
      };
    } catch {
      return { exists: false };
    }
  });
}
