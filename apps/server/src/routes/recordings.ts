import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import { probeVideo, createFakeProbe, type VideoMetadata } from '../services/recording/metadata.js';
import { ingestRecording, type IngestResult } from '../services/recording/ingest.js';
import { loadStoryboard, saveStoryboard, createStoryboard, addScene } from '../services/storyboard/index.js';
import { analyzeRecording } from '../services/video-analysis/index.js';
import { proposeBoundaries } from '../services/recording/propose-boundaries.js';
import { splitRecording, type SceneBoundary } from '../services/recording/split.js';
import { SceneSchema, type Scene } from '@vpa/shared';
import { projectFiles } from '../services/project/paths.js';

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  workspaceRoot: string;
  /** Use fake ffprobe in test environments */
  probe?: typeof probeVideo;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

async function resolveProjectEntry(store: ProjectStore, projectId: string) {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry;
}

export async function registerRecordingRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, llm, workspaceRoot } = deps;
  const probe = deps.probe ?? probeVideo;

  // POST /api/projects/:id/scenes/:sceneId/recording — upload recording for a specific scene
  app.post('/api/projects/:id/scenes/:sceneId/recording', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    // Verify scene exists in storyboard
    const sb = await loadStoryboard(projectPath);
    if (!sb) {
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }
    if (!sb.scenes.some((s) => s.id === sceneId)) {
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    }

    const data = await req.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded', code: 'no_file' });
    }

    // Save to temp, probe, then ingest
    const tmpDir = path.join(projectPath, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `upload-${randomUUID()}.mp4`);

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      await writeFile(tmpFile, Buffer.concat(chunks));

      const metadata = await probe(tmpFile);
      const result = await ingestRecording(projectPath, sceneId, tmpFile, metadata);
      return result;
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });

  // POST /api/projects/:id/recordings/bulk — upload multiple recordings
  app.post('/api/projects/:id/recordings/bulk', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) {
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }

    const parts = req.parts();
    const results: IngestResult[] = [];
    let sceneIndex = 0;

    const tmpDir = path.join(projectPath, '.tmp');
    await mkdir(tmpDir, { recursive: true });

    for await (const part of parts) {
      if (part.type !== 'file') continue;
      if (sceneIndex >= sb.scenes.length) break;

      const scene = sb.scenes[sceneIndex]!;
      const tmpFile = path.join(tmpDir, `upload-${randomUUID()}.mp4`);

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        await writeFile(tmpFile, Buffer.concat(chunks));

        const metadata = await probe(tmpFile);
        const result = await ingestRecording(projectPath, scene.id, tmpFile, metadata);
        results.push(result);
      } finally {
        await unlink(tmpFile).catch(() => {});
      }

      sceneIndex++;
    }

    return { results, assignedCount: results.length, totalScenes: sb.scenes.length };
  });

  // GET /api/projects/:id/scenes/:sceneId/recording/video — stream the recording mp4.
  // Honors Range header so the browser video player can seek without
  // downloading the whole file.
  app.get('/api/projects/:id/scenes/:sceneId/recording/video', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    if (!scene.recording?.source) {
      return reply.status(404).send({ error: 'No recording for this scene', code: 'no_recording' });
    }

    const filePath = path.join(projectPath, scene.recording.source);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return reply.status(404).send({ error: 'Recording file missing on disk', code: 'file_missing' });
    }

    const total = fileStat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.mp4' ? 'video/mp4' : ext === '.mov' ? 'video/quicktime' : 'application/octet-stream';

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

  // GET /api/projects/:id/scenes/:sceneId/recording/metadata — get metadata for scene recording
  app.get('/api/projects/:id/scenes/:sceneId/recording/metadata', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) {
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) {
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    }

    if (!scene.recording?.source) {
      return reply.status(404).send({ error: 'No recording for this scene', code: 'no_recording' });
    }

    const filePath = path.join(projectPath, scene.recording.source);
    const metadata = await probe(filePath);
    return metadata;
  });

  // POST /api/projects/:id/recordings/generate-storyboard — generate storyboard from uploaded recordings
  app.post('/api/projects/:id/recordings/generate-storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = await resolveProjectEntry(store, id);
    const projectPath = entry.path;

    // Expect multipart with one or more MP4 files
    const parts = req.parts();
    const uploadedFiles: Array<{ tmpFile: string; filename: string }> = [];

    const tmpDir = path.join(projectPath, '.tmp');
    await mkdir(tmpDir, { recursive: true });

    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const tmpFile = path.join(tmpDir, `upload-${randomUUID()}.mp4`);
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) {
        chunks.push(chunk);
      }
      await writeFile(tmpFile, Buffer.concat(chunks));
      uploadedFiles.push({ tmpFile, filename: part.filename });
    }

    if (uploadedFiles.length === 0) {
      return reply.status(400).send({ error: 'No files uploaded', code: 'no_files' });
    }

    // Probe all files for metadata
    const metadatas: VideoMetadata[] = [];
    for (const { tmpFile } of uploadedFiles) {
      metadatas.push(await probe(tmpFile));
    }

    // Analyze each recording to generate scene descriptions
    const scenes: Scene[] = [];
    for (let i = 0; i < uploadedFiles.length; i++) {
      const analysis = await analyzeRecording(
        {
          filename: uploadedFiles[i]!.filename,
          duration_sec: metadatas[i]!.duration_sec,
          width: metadatas[i]!.width,
          height: metadatas[i]!.height,
          sceneIndex: i,
          totalScenes: uploadedFiles.length,
          projectObjective: (entry as Record<string, unknown>).objective as string | undefined,
          projectPath: entry.path,
        },
        llm,
        workspaceRoot,
      );

      scenes.push(
        SceneSchema.parse({
          id: `scene-${String(i + 1).padStart(2, '0')}`,
          name: analysis.name,
          description: analysis.description,
          type: analysis.type,
        }),
      );
    }

    // Create storyboard
    const project = {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      created: entry.lastOpened ?? new Date().toISOString(),
      brand: null,
    };
    const storyboard = createStoryboard(project, scenes);
    await saveStoryboard(projectPath, storyboard);

    // Now ingest each recording to its scene
    const files = projectFiles(projectPath);
    await mkdir(files.recordingsDir, { recursive: true });

    for (let i = 0; i < uploadedFiles.length; i++) {
      await ingestRecording(projectPath, scenes[i]!.id, uploadedFiles[i]!.tmpFile, metadatas[i]!);
    }

    // Clean up temp files
    for (const { tmpFile } of uploadedFiles) {
      await unlink(tmpFile).catch(() => {});
    }

    // Return the final storyboard (with recordings attached)
    const finalSb = await loadStoryboard(projectPath);
    return finalSb;
  });

  // POST /api/projects/:id/recordings/propose-split — upload a single file, get AI-proposed scene boundaries
  app.post('/api/projects/:id/recordings/propose-split', async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = await resolveProjectEntry(store, id);
    const files = projectFiles(entry.path);
    await mkdir(files.recordingsDir, { recursive: true });

    const data = await req.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded', code: 'no_file' });
    }

    // Save uploaded file as _source.mp4
    const sourcePath = path.join(files.recordingsDir, '_source.mp4');
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    await writeFile(sourcePath, Buffer.concat(chunks));

    // Probe metadata
    const metadata = await probe(sourcePath);

    // Propose boundaries via LLM
    const boundaries = await proposeBoundaries(
      { duration_sec: metadata.duration_sec, filename: '_source.mp4' },
      llm,
      workspaceRoot,
    );

    return { boundaries, sourceFile: '_source.mp4', metadata };
  });

  // POST /api/projects/:id/recordings/execute-split — split source file at given boundaries
  app.post('/api/projects/:id/recordings/execute-split', async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = await resolveProjectEntry(store, id);
    const files = projectFiles(entry.path);

    const body = req.body as { boundaries?: SceneBoundary[] } | null;
    if (!body?.boundaries || !Array.isArray(body.boundaries) || body.boundaries.length === 0) {
      return reply.status(400).send({ error: 'boundaries array is required', code: 'invalid_request' });
    }

    const sourcePath = path.join(files.recordingsDir, '_source.mp4');

    // Split into per-scene files
    const splitResults = await splitRecording(sourcePath, files.recordingsDir, body.boundaries);

    // Create scenes from boundaries
    const scenes: Scene[] = splitResults.map((r, i) => {
      const b = body.boundaries![i]!;
      return SceneSchema.parse({
        id: r.sceneId,
        name: b.suggested_name,
        description: `Split from source recording (${r.start_sec.toFixed(1)}s - ${r.end_sec.toFixed(1)}s)`,
        type: 'desktop',
      });
    });

    // Create and save storyboard
    const project = {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      created: entry.lastOpened ?? new Date().toISOString(),
      brand: null,
    };
    const storyboard = createStoryboard(project, scenes);
    await saveStoryboard(entry.path, storyboard);

    // Ingest each clip
    for (const sr of splitResults) {
      const clipPath = path.join(files.recordingsDir, `${sr.sceneId}.mp4`);
      const clipMeta: VideoMetadata = {
        duration_sec: sr.duration_sec,
        width: 0, height: 0,
        codec: 'h264', fps: 30,
        size_bytes: 0,
      };
      await ingestRecording(entry.path, sr.sceneId, clipPath, clipMeta);
    }

    // Return final storyboard
    const finalSb = await loadStoryboard(entry.path);
    return finalSb ?? storyboard;
  });
}
