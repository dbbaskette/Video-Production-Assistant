import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { AssetMappingRequestSchema } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { AssetImportError, AssetStore, ASSET_MAX_BYTES } from '../services/assets/store.js';
import {
  stageUploadStream,
  StagedUploadError,
} from '../services/recording/staged-upload.js';
import { RevisionError, RevisionStore } from '../services/revisions/store.js';
import { resolveSafeProjectPath } from '../services/project/safe-path.js';
import { loadStoryboard } from '../services/storyboard/index.js';

async function resolveRoot(store: ProjectStore, projectId: string): Promise<string | null> {
  return (await store.readTracker()).projects.find((project) => project.id === projectId)?.path ?? null;
}

function assetStatus(error: AssetImportError): number {
  return error.code === 'file_too_large' ? 413 : 400;
}

export async function registerAssetRoutes(app: FastifyInstance, deps: {
  store: ProjectStore;
  createAssetStore?: (root: string) => AssetStore;
}): Promise<void> {
  const createAssetStore = deps.createAssetStore ?? ((root: string) => new AssetStore(root));
  app.get('/api/projects/:id/assets', async (request, reply) => {
    const { id } = request.params as { id: string };
    const root = await resolveRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    const assetStore = createAssetStore(root);
    const storyboard = await loadStoryboard(root);
    const legacy = storyboard?.scenes.filter((scene) => scene.recording?.source && !scene.recording.asset_id) ?? [];
    const commands = [];
    const migrationWarnings: Array<{ sceneId: string; code: string }> = [];
    for (const scene of legacy) {
      try {
        const asset = await assetStore.registerLegacy(scene.recording!.source, scene.recording!.source_role ?? 'screen');
        commands.push({
          type: 'scene.assign-asset' as const,
          sceneId: scene.id,
          assetId: asset.id,
          role: scene.recording!.source_role ?? 'screen',
          timingOriginMs: scene.recording!.timing_origin_ms ?? 0,
        });
      } catch {
        migrationWarnings.push({ sceneId: scene.id, code: 'legacy_source_unavailable' });
      }
    }
    if (commands.length > 0) {
      const revisions = new RevisionStore(root);
      const expectedRevision = await revisions.currentRevision();
      const key = createHash('sha256').update(JSON.stringify(commands)).digest('hex').slice(0, 40);
      try {
        await revisions.execute({
          expectedRevision,
          idempotencyKey: `legacy-${key}`,
          targetState: 'accepted',
          commands,
        });
      } catch (error) {
        if (!(error instanceof RevisionError && error.code === 'stale_revision')) throw error;
        migrationWarnings.push({ sceneId: '*', code: 'migration_conflict' });
      }
    }
    return { assets: await assetStore.list(), migrationWarnings };
  });

  app.post('/api/projects/:id/assets/import', async (request, reply) => {
    const { id } = request.params as { id: string };
    const root = await resolveRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    const staging = await mkdtemp(path.join(tmpdir(), 'vpa-asset-upload-'));
    const assets = [];
    try {
      const parts = request.parts({ limits: { fileSize: ASSET_MAX_BYTES, files: 100 } });
      for await (const part of parts) {
        if (part.type !== 'file') continue;
        const extension = path.extname(part.filename).toLowerCase();
        const stagedPath = path.join(staging, `${randomUUID()}${extension}`);
        const staged = await stageUploadStream(stagedPath, part.file, ASSET_MAX_BYTES);
        if (part.file.truncated) throw new StagedUploadError('file_too_large', 'Uploaded file exceeds the byte limit.');
        assets.push(await createAssetStore(root).importFile(staged.path, { originalName: part.filename }));
      }
      if (assets.length === 0) return reply.status(400).send({ error: 'No files uploaded.', code: 'no_files' });
      return reply.status(201).send({ assets });
    } catch (error) {
      if (error instanceof AssetImportError) {
        return reply.status(assetStatus(error)).send({ error: error.message, code: error.code });
      }
      if (error instanceof StagedUploadError || error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.status(413).send({ error: 'Files must be 2 GiB or smaller.', code: 'file_too_large' });
      }
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  app.post('/api/projects/:id/assets/register-legacy', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { source?: unknown };
    if (typeof body?.source !== 'string') return reply.status(400).send({ error: 'A legacy source is required.', code: 'invalid_request' });
    const root = await resolveRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    try {
      return reply.status(201).send({ asset: await createAssetStore(root).registerLegacy(body.source) });
    } catch (error) {
      if (error instanceof AssetImportError) return reply.status(assetStatus(error)).send({ error: error.message, code: error.code });
      throw error;
    }
  });

  app.get('/api/projects/:id/assets/:assetId/content', async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    const root = await resolveRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    const asset = await createAssetStore(root).get(assetId);
    if (!asset) return reply.status(404).send({ error: 'Asset not found.', code: 'not_found' });
    const absolute = await resolveSafeProjectPath(root, asset.source);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) return reply.status(404).send({ error: 'Asset bytes are missing.', code: 'file_missing' });
    reply.header('Content-Type', asset.mime_type);
    reply.header('Content-Length', info.size);
    reply.header('Accept-Ranges', 'bytes');
    return reply.send(createReadStream(absolute));
  });

  app.post('/api/projects/:id/assets/:assetId/retry', async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    const root = await resolveRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    try {
      return { asset: await createAssetStore(root).retryPreparation(assetId) };
    } catch (error) {
      if (error instanceof AssetImportError) return reply.status(404).send({ error: error.message, code: 'not_found' });
      throw error;
    }
  });

  app.post('/api/projects/:id/assets/mappings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = AssetMappingRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Asset mapping is invalid.', code: 'invalid_request' });
    const root = await resolveRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    try {
      const result = await new RevisionStore(root).execute({
        expectedRevision: parsed.data.expectedRevision,
        idempotencyKey: parsed.data.idempotencyKey,
        commands: parsed.data.mappings.map((mapping) => ({
          type: 'scene.assign-asset' as const,
          sceneId: mapping.sceneId,
          assetId: mapping.assetId,
          role: mapping.role,
          timingOriginMs: mapping.timingOriginMs,
        })),
      });
      return { result };
    } catch (error) {
      if (error instanceof RevisionError) {
        const status = error.code === 'stale_revision' || error.code === 'idempotency_conflict' ? 409 : 400;
        return reply.status(status).send({ error: error.message, code: error.code, currentRevision: error.currentRevision });
      }
      throw error;
    }
  });
}
