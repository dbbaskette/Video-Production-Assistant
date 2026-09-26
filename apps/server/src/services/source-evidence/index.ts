import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  SourceTranscriptSchema,
  mappedTranscriptSrt,
  mapTranscriptToComposition,
  type Asset,
  type EvidenceItem,
  type Scene,
  type SourceTranscript,
  type TranscriptWord,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import type { ResolvedVideoModel } from '../llm/model-router.js';
import {
  deleteFile,
  generateWithVideo,
  uploadVideo,
  waitForFileActive,
  type GeminiFilesTransport,
} from '../video-narration/gemini-files.js';

const execFileAsync = promisify(execFile);
const SETTINGS = { language: 'en', diarization: true, word_timestamps: true, version: 1 } as const;
const settingsHash = createHash('sha256').update(JSON.stringify(SETTINGS)).digest('hex');
const ModelTranscriptSchema = z.object({
  words: z.array(z.object({
    text: z.string().trim().min(1).max(120),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
    confidence: z.number().min(0).max(1).optional(),
    speaker: z.string().trim().min(1).max(80).optional(),
  }).strict()).max(100_000),
}).strict();

export interface SourceEvidenceOptions {
  transport?: GeminiFilesTransport;
  persist?: typeof atomicWriteFile;
  run?: (args: string[]) => Promise<void>;
  now?: () => Date;
}

export class SourceEvidenceError extends Error {
  readonly code = 'source_evidence_failed';
}

function cleanJson(value: string): string {
  return /^```json\s*([\s\S]*?)\s*```$/i.exec(value.trim())?.[1] ?? value.trim();
}

function evidenceRoot(projectRoot: string, asset: Asset): string {
  return path.join(projectRoot, '.vpa', 'evidence', asset.checksum, settingsHash);
}

function makePassages(words: TranscriptWord[]) {
  const passages = [];
  for (let start = 0; start < words.length; start += 40) {
    const group = words.slice(start, start + 40);
    if (!group.length) continue;
    passages.push({
      id: `passage_${String(start).padStart(6, '0')}`,
      start_ms: group[0]!.start_ms,
      end_ms: group.at(-1)!.end_ms,
      text: group.map((word) => word.text).join(' '),
      word_ids: group.map((word) => word.id),
    });
  }
  return passages;
}

export class SourceEvidenceService {
  private readonly transport: GeminiFilesTransport;
  private readonly persist: typeof atomicWriteFile;
  private readonly run: (args: string[]) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: SourceEvidenceOptions = {}) {
    this.transport = options.transport ?? { uploadVideo, waitForFileActive, generateWithVideo, deleteFile };
    this.persist = options.persist ?? atomicWriteFile;
    this.run = options.run ?? (async (args) => { await execFileAsync('ffmpeg', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }); });
    this.now = options.now ?? (() => new Date());
  }

  async ensureTranscript(input: { projectRoot: string; asset: Asset; sourcePath: string; model: ResolvedVideoModel; scene: Scene }): Promise<SourceTranscript> {
    const root = evidenceRoot(input.projectRoot, input.asset);
    const artifact = path.join(root, `transcript-${input.model.summary.entry_id.replace(/[^A-Za-z0-9_-]/g, '_')}-${input.model.model.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    try {
      const cached = SourceTranscriptSchema.parse(JSON.parse(await readFile(artifact, 'utf8')));
      if (cached.source_sha256 === input.asset.checksum && cached.model === input.model.model && cached.settings_hash === settingsHash) return cached;
    } catch { /* missing or stale */ }

    let uploaded: Awaited<ReturnType<GeminiFilesTransport['uploadVideo']>> | undefined;
    try {
      uploaded = await this.transport.uploadVideo(input.model.apiKey, input.sourcePath, input.asset.mime_type, `${input.asset.id} English transcription`);
      const active = await this.transport.waitForFileActive(input.model.apiKey, uploaded.name);
      const raw = await this.transport.generateWithVideo({
        apiKey: input.model.apiKey,
        model: input.model.model,
        systemPrompt: 'Transcribe the English speech in this media. Return only strict JSON. Do not infer missing speech or distribute words evenly.',
        userPrompt: 'Return {"words":[{"text":"...","start_ms":0,"end_ms":100,"confidence":0.9,"speaker":"Speaker 1"}]}. Preserve pauses, noise uncertainty, and speaker changes. Use actual media timing.',
        videoFileUri: active.uri,
        videoMimeType: active.mimeType,
        temperature: 0,
        responseMimeType: 'application/json',
        maxTokens: 32_768,
      });
      const parsed = ModelTranscriptSchema.parse(JSON.parse(cleanJson(raw)));
      const words = parsed.words.map((word, index) => ({ ...word, id: `word_${String(index).padStart(6, '0')}` }));
      const durationMs = Math.max(1, Math.round((input.asset.duration_sec ?? words.at(-1)?.end_ms ?? 1)) * (input.asset.duration_sec ? 1_000 : 1));
      const transcript = SourceTranscriptSchema.parse({
        version: 1,
        source_asset_id: input.asset.id,
        source_sha256: input.asset.checksum,
        language: 'en',
        provider: 'gemini',
        model: input.model.model,
        settings_hash: settingsHash,
        created_at: this.now().toISOString(),
        coverage: [{ start_ms: 0, end_ms: durationMs }],
        words,
        passages: makePassages(words),
      });
      await mkdir(root, { recursive: true });
      await this.persist(artifact, JSON.stringify(transcript, null, 2));
      return transcript;
    } catch (error) {
      throw error instanceof SourceEvidenceError ? error : new SourceEvidenceError('Source transcription failed. Existing edits and exports were not changed.');
    } finally {
      if (uploaded) await this.transport.deleteFile(input.model.apiKey, uploaded.name).catch(() => false);
    }
  }

  async writeMappedSrt(projectRoot: string, scene: Scene, transcript: SourceTranscript): Promise<SourceTranscript> {
    const words = scene.composition ? mapTranscriptToComposition(transcript, scene.composition) : transcript.words.map((word) => ({ ...word, mapped_id: word.id, clip_instance_id: 'clip_source', timeline_start_ms: word.start_ms, timeline_end_ms: word.end_ms }));
    const root = evidenceRoot(projectRoot, { checksum: transcript.source_sha256 } as Asset);
    const file = path.join(root, `${scene.id}.srt`);
    await mkdir(root, { recursive: true });
    await this.persist(file, mappedTranscriptSrt(words));
    return SourceTranscriptSchema.parse({ ...transcript, subtitles: { srt: path.relative(projectRoot, file) } });
  }

  async createArtifact(input: { projectRoot: string; asset: Asset; sourcePath: string; kind: 'frame' | 'contact-sheet' | 'excerpt'; startMs: number; endMs?: number; density?: number }): Promise<EvidenceItem> {
    const endMs = input.endMs ?? input.startMs;
    if (input.startMs < 0 || endMs < input.startMs || (input.kind === 'excerpt' && endMs - input.startMs > 30_000)) throw new SourceEvidenceError('Evidence interval is invalid or exceeds the 30-second excerpt limit.');
    const key = createHash('sha256').update(JSON.stringify({ kind: input.kind, startMs: input.startMs, endMs, density: input.density ?? 8, settingsHash })).digest('hex').slice(0, 20);
    const root = evidenceRoot(input.projectRoot, input.asset);
    const extension = input.kind === 'excerpt' ? 'mp4' : 'jpg';
    const file = path.join(root, `${input.kind}-${key}.${extension}`);
    await mkdir(root, { recursive: true });
    try {
      await readFile(file);
    } catch {
      const start = (input.startMs / 1_000).toFixed(3);
      if (input.kind === 'frame') await this.run(['-y', '-ss', start, '-i', input.sourcePath, '-frames:v', '1', file]);
      else if (input.kind === 'excerpt') await this.run(['-y', '-ss', start, '-t', ((endMs - input.startMs) / 1_000).toFixed(3), '-i', input.sourcePath, '-c:v', 'libx264', '-c:a', 'aac', file]);
      else {
        const duration = Math.max(1, endMs - input.startMs);
        const fps = Math.max(0.001, (input.density ?? 8) / (duration / 1_000));
        await this.run(['-y', '-ss', start, '-t', (duration / 1_000).toFixed(3), '-i', input.sourcePath, '-vf', `fps=${fps},scale=320:-1,tile=4x2`, '-frames:v', '1', file]);
      }
    }
    return {
      id: `evidence_${key}`,
      kind: input.kind,
      source_asset_id: input.asset.id,
      source_start_ms: input.startMs,
      source_end_ms: endMs,
      path: path.relative(input.projectRoot, file),
      source_sha256: input.asset.checksum,
      settings_hash: settingsHash,
      created_at: this.now().toISOString(),
    };
  }
}
