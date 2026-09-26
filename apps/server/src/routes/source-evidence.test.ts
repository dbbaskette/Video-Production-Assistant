import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../services/project/store.js';
import { AssetStore } from '../services/assets/store.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { registerSourceEvidenceRoutes } from './source-evidence.js';
import type { SourceEvidenceService } from '../services/source-evidence/index.js';
import type { ModelRouter } from '../services/llm/model-router.js';

describe('source evidence routes', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it('commits configured transcription and text-only corrections without changing word timing', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'vpa-evidence-route-home-'));
    const projects = await mkdtemp(path.join(tmpdir(), 'vpa-evidence-route-projects-'));
    roots.push(home, projects);
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'evidence-route' });
    const source = path.join(project.path, 'source.mp4');
    await writeFile(source, Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(24)]));
    const asset = await new AssetStore(project.path, { probe: vi.fn().mockResolvedValue({ duration_sec: 5, width: 1280, height: 720, codec: 'h264', fps: 30, size_bytes: 32 }) }).importFile(source, { originalName: 'source.mp4' });
    await saveStoryboard(project.path, { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [{ id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop', recording: { source: asset.source, asset_id: asset.id, duration_sec: 5 }, composition: { version: 1, audio_mix: {}, clips: [{ id: 'clip_source-001', source_asset_id: asset.id, source_role: 'screen', source_in_ms: 0, source_out_ms: 5_000, timeline_start_ms: 0, linked_tracks: [] }] } }] });
    const transcript = { version: 1 as const, source_asset_id: asset.id, source_sha256: asset.checksum, language: 'en' as const, provider: 'gemini' as const, model: 'gemini-test', settings_hash: 'b'.repeat(64), created_at: '2026-09-25T12:00:00.000Z', coverage: [{ start_ms: 0, end_ms: 5_000 }], words: [{ id: 'word_000001', text: 'helo', start_ms: 100, end_ms: 500 }], passages: [{ id: 'passage_000001', start_ms: 100, end_ms: 500, text: 'helo', word_ids: ['word_000001'] }] };
    const evidence = { ensureTranscript: vi.fn().mockResolvedValue(transcript), writeMappedSrt: vi.fn().mockImplementation(async (_root, _scene, value) => ({ ...value, subtitles: { srt: '.vpa/evidence/test.srt' } })), createArtifact: vi.fn() } as unknown as SourceEvidenceService;
    const router = { resolveVideo: vi.fn().mockResolvedValue({ apiKey: 'secret', model: 'gemini-test', summary: { entry_id: 'video', provider: 'gemini' } }) } as unknown as ModelRouter;
    const app = Fastify();
    await registerSourceEvidenceRoutes(app, { store, router, evidence });

    const analyzed = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/scenes/scene-01/evidence/transcribe` });
    expect(analyzed.statusCode).toBe(200);
    expect(evidence.ensureTranscript).toHaveBeenCalledOnce();
    const corrected = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}/scenes/scene-01/evidence/words/word_000001`, payload: { text: 'hello' } });
    expect(corrected.statusCode).toBe(200);
    const word = (await loadStoryboard(project.path))!.scenes[0]!.transcript!.words[0]!;
    expect(word).toMatchObject({ text: 'hello', original_text: 'helo', start_ms: 100, end_ms: 500 });
    await app.close();
  });
});
