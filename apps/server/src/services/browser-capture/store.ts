import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BrowserCaptureCreateSchema,
  BrowserCaptureSessionSchema,
  captureRoleToAssetRole,
  type BrowserCaptureChunkAck,
  type BrowserCaptureCreate,
  type BrowserCaptureSession,
  type BrowserCaptureTrack,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { AssetStore, ASSET_MAX_BYTES } from '../assets/store.js';
import { projectFiles } from '../project/paths.js';
import { RevisionStore } from '../revisions/store.js';

const execFileAsync = promisify(execFile);
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const STALE_AFTER_MS = 15_000;

interface ChunkRecord {
  sequence: number;
  checksum: string;
  bytes: number;
}

interface CaptureRecord {
  version: 1;
  session: BrowserCaptureSession;
  chunks: Record<string, ChunkRecord[]>;
}

export interface CaptureProbeResult {
  durationSec: number;
  width?: number;
  height?: number;
}

export interface BrowserCaptureStoreOptions {
  persist?: typeof atomicWriteFile;
  probe?: (filePath: string, kind: 'video' | 'audio') => Promise<CaptureProbeResult>;
  createAssetStore?: (root: string) => AssetStore;
  now?: () => Date;
  staleAfterMs?: number;
}

export class BrowserCaptureError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_state' | 'invalid_chunk' | 'chunk_conflict' | 'incomplete_tracks' | 'alignment_failed' | 'assembly_failed',
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'BrowserCaptureError';
  }
}

const mutationTails = new Map<string, Promise<void>>();

async function atomicWriteBuffer(target: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

async function defaultProbe(filePath: string, kind: 'video' | 'audio'): Promise<CaptureProbeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ], { timeout: 30_000 });
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; duration?: string; width?: number; height?: number }>;
  };
  const stream = parsed.streams?.find((candidate) => candidate.codec_type === kind);
  if (!stream) throw new Error(`No ${kind} stream found.`);
  const durationSec = Number(parsed.format?.duration ?? stream.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 20 * 60) {
    throw new Error('Capture duration is invalid.');
  }
  return { durationSec, width: stream.width, height: stream.height };
}

function recordPath(projectRoot: string, sessionId: string): string {
  return path.join(projectFiles(projectRoot).capturesDir, sessionId, 'session.json');
}

function chunkPath(projectRoot: string, sessionId: string, trackId: string, sequence: number): string {
  return path.join(projectFiles(projectRoot).capturesDir, sessionId, 'chunks', trackId, `${sequence.toString().padStart(6, '0')}.bin`);
}

export class BrowserCaptureStore {
  private readonly persist: typeof atomicWriteFile;
  private readonly probe: NonNullable<BrowserCaptureStoreOptions['probe']>;
  private readonly createAssetStore: NonNullable<BrowserCaptureStoreOptions['createAssetStore']>;
  private readonly now: () => Date;
  private readonly staleAfterMs: number;

  constructor(private readonly projectRoot: string, options: BrowserCaptureStoreOptions = {}) {
    this.persist = options.persist ?? atomicWriteFile;
    this.probe = options.probe ?? defaultProbe;
    this.createAssetStore = options.createAssetStore ?? ((root) => new AssetStore(root));
    this.now = options.now ?? (() => new Date());
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  }

  private async serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${path.resolve(this.projectRoot)}:${sessionId}`;
    const prior = mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    mutationTails.set(key, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (mutationTails.get(key) === current) mutationTails.delete(key);
    }
  }

  private async readRecord(sessionId: string): Promise<CaptureRecord> {
    try {
      const raw = JSON.parse(await readFile(recordPath(this.projectRoot, sessionId), 'utf8')) as CaptureRecord;
      return { version: 1, session: BrowserCaptureSessionSchema.parse(raw.session), chunks: raw.chunks ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BrowserCaptureError('not_found', 'Capture session not found.');
      throw error;
    }
  }

  private async saveRecord(record: CaptureRecord): Promise<void> {
    await this.persist(recordPath(this.projectRoot, record.session.id), JSON.stringify(record, null, 2));
  }

  async create(projectId: string, input: BrowserCaptureCreate): Promise<BrowserCaptureSession> {
    const capture = BrowserCaptureCreateSchema.parse(input);
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const session = BrowserCaptureSessionSchema.parse({
      version: 1,
      id,
      project_id: projectId,
      scene_id: capture.sceneId,
      status: 'recording',
      created_at: timestamp,
      updated_at: timestamp,
      common_clock_origin_ms: capture.commonClockOriginMs,
      tracks: capture.tracks.map((track) => ({
        id: track.id,
        role: track.role,
        kind: track.kind,
        mime_type: track.mimeType,
        timing_origin_ms: track.timingOriginMs,
        shared_audio_available: track.sharedAudioAvailable,
        chunks: 0,
        bytes: 0,
      })),
    });
    await this.saveRecord({ version: 1, session, chunks: Object.fromEntries(session.tracks.map((track) => [track.id, []])) });
    return session;
  }

  async list(): Promise<BrowserCaptureSession[]> {
    let ids: string[];
    try {
      ids = await readdir(projectFiles(this.projectRoot).capturesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const sessions: BrowserCaptureSession[] = [];
    for (const id of ids) {
      try {
        const session = await this.serialize(id, async () => {
          const record = await this.readRecord(id);
          if (record.session.status === 'recording' && this.now().getTime() - Date.parse(record.session.updated_at) > this.staleAfterMs) {
            record.session = BrowserCaptureSessionSchema.parse({
              ...record.session,
              status: 'incomplete',
              updated_at: this.now().toISOString(),
              failure: { code: 'capture_interrupted', message: 'Capture ended before final assembly.', retryable: true },
            });
            await this.saveRecord(record);
          }
          return record.session;
        });
        sessions.push(session);
      } catch (error) {
        if (!(error instanceof BrowserCaptureError && error.code === 'not_found')) throw error;
      }
    }
    return sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(sessionId: string): Promise<BrowserCaptureSession> {
    return (await this.readRecord(sessionId)).session;
  }

  async appendChunk(sessionId: string, trackId: string, sequence: number, bytes: Buffer): Promise<BrowserCaptureChunkAck> {
    if (!Number.isInteger(sequence) || sequence < 0 || bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES) {
      throw new BrowserCaptureError('invalid_chunk', 'Capture chunk is invalid.');
    }
    return this.serialize(sessionId, async () => {
      const record = await this.readRecord(sessionId);
      if (!['recording', 'incomplete'].includes(record.session.status)) {
        throw new BrowserCaptureError('invalid_state', 'This capture no longer accepts chunks.');
      }
      const trackIndex = record.session.tracks.findIndex((track) => track.id === trackId);
      if (trackIndex < 0) throw new BrowserCaptureError('not_found', 'Capture track not found.');
      const chunks = record.chunks[trackId] ?? [];
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const existing = chunks.find((chunk) => chunk.sequence === sequence);
      if (existing) {
        if (existing.checksum !== checksum || existing.bytes !== bytes.length) {
          throw new BrowserCaptureError('chunk_conflict', 'This chunk sequence already contains different bytes.');
        }
        return { sessionId, trackId, sequence, checksum, bytes: bytes.length, reused: true };
      }
      if (sequence !== chunks.length) throw new BrowserCaptureError('invalid_chunk', 'Capture chunks must be uploaded in order.');
      const total = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) + bytes.length;
      if (total > ASSET_MAX_BYTES) throw new BrowserCaptureError('invalid_chunk', 'Capture track exceeds the 2 GiB limit.');

      await atomicWriteBuffer(chunkPath(this.projectRoot, sessionId, trackId, sequence), bytes);
      chunks.push({ sequence, checksum, bytes: bytes.length });
      record.chunks[trackId] = chunks;
      const tracks = record.session.tracks.map((track, index) => index === trackIndex
        ? { ...track, chunks: chunks.length, bytes: total }
        : track);
      record.session = BrowserCaptureSessionSchema.parse({ ...record.session, status: 'recording', tracks, updated_at: this.now().toISOString(), failure: undefined });
      await this.saveRecord(record);
      return { sessionId, trackId, sequence, checksum, bytes: bytes.length, reused: false };
    });
  }

  async markIncomplete(sessionId: string, code = 'capture_stopped'): Promise<BrowserCaptureSession> {
    return this.serialize(sessionId, async () => {
      const record = await this.readRecord(sessionId);
      if (record.session.status === 'completed') return record.session;
      record.session = BrowserCaptureSessionSchema.parse({
        ...record.session,
        status: 'incomplete',
        updated_at: this.now().toISOString(),
        failure: { code, message: 'Capture is incomplete. Uploaded tracks can still be recovered.', retryable: true },
      });
      await this.saveRecord(record);
      return record.session;
    });
  }

  async complete(sessionId: string): Promise<BrowserCaptureSession> {
    return this.serialize(sessionId, async () => {
      const record = await this.readRecord(sessionId);
      if (record.session.status === 'completed') return record.session;
      const missing = record.session.tracks.find((track) => (record.chunks[track.id]?.length ?? 0) === 0);
      if (missing) throw new BrowserCaptureError('incomplete_tracks', `Track ${missing.role} has no uploaded chunks.`, true);

      record.session = BrowserCaptureSessionSchema.parse({ ...record.session, status: 'assembling', updated_at: this.now().toISOString(), failure: undefined });
      await this.saveRecord(record);
      try {
        const assembled: Array<{ track: BrowserCaptureTrack; filePath: string; probe: CaptureProbeResult }> = [];
        for (const track of record.session.tracks) {
          const chunks = record.chunks[track.id] ?? [];
          if (chunks.some((chunk, index) => chunk.sequence !== index)) throw new BrowserCaptureError('incomplete_tracks', `Track ${track.role} has a chunk gap.`, true);
          const filePath = path.join(projectFiles(this.projectRoot).capturesDir, sessionId, `assembled-${track.id}.webm`);
          const handle = await open(filePath, 'w');
          try {
            for (const chunk of chunks) await handle.writeFile(await readFile(chunkPath(this.projectRoot, sessionId, track.id, chunk.sequence)));
          } finally {
            await handle.close();
          }
          const probe = await this.probe(filePath, track.kind);
          assembled.push({ track, filePath, probe });
        }

        const starts = assembled.map(({ track }) => track.timing_origin_ms);
        const middles = assembled.map(({ track, probe }) => track.timing_origin_ms + probe.durationSec * 500);
        const ends = assembled.map(({ track, probe }) => track.timing_origin_ms + probe.durationSec * 1_000);
        const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
        if (spread(starts) > 100 || spread(middles) > 100 || spread(ends) > 100) {
          throw new BrowserCaptureError('alignment_failed', 'Captured tracks differ by more than 100 ms.', true);
        }

        const assetStore = this.createAssetStore(this.projectRoot);
        const imported: BrowserCaptureTrack[] = [];
        for (const entry of assembled) {
          const asset = await assetStore.importFile(entry.filePath, {
            originalName: `${entry.track.role}.webm`,
            captureSessionId: record.session.id,
            sourceRole: captureRoleToAssetRole(entry.track.role),
            timingOriginMs: entry.track.timing_origin_ms,
            mediaKind: entry.track.kind,
            mimeType: entry.track.mime_type.split(';')[0]!,
            validatedMediaMetadata: { duration_sec: entry.probe.durationSec, width: entry.probe.width, height: entry.probe.height },
            ...(entry.track.kind === 'video' ? { validatedVideoMetadata: {
              duration_sec: entry.probe.durationSec,
              width: entry.probe.width ?? 1,
              height: entry.probe.height ?? 1,
              codec: 'browser-capture',
              fps: 30,
              size_bytes: (await stat(entry.filePath)).size,
            } } : {}),
          });
          imported.push({ ...entry.track, asset_id: asset.id });
        }

        const revisions = new RevisionStore(this.projectRoot);
        const expectedRevision = await revisions.currentRevision();
        await revisions.execute({
          expectedRevision,
          idempotencyKey: `browser-capture-${sessionId}`,
          targetState: 'accepted',
          commands: imported.map((track) => ({
            type: 'scene.assign-asset' as const,
            sceneId: record.session.scene_id,
            assetId: track.asset_id!,
            role: captureRoleToAssetRole(track.role),
            timingOriginMs: track.timing_origin_ms,
          })),
        });
        record.session = BrowserCaptureSessionSchema.parse({ ...record.session, status: 'completed', tracks: imported, updated_at: this.now().toISOString(), failure: undefined });
        await this.saveRecord(record);
        return record.session;
      } catch (error) {
        record.session = BrowserCaptureSessionSchema.parse({
          ...record.session,
          status: 'failed',
          updated_at: this.now().toISOString(),
          failure: {
            code: error instanceof BrowserCaptureError ? error.code : 'assembly_failed',
            message: error instanceof BrowserCaptureError ? error.message : 'Capture assembly failed. Retry with the uploaded chunks.',
            retryable: true,
          },
        });
        await this.saveRecord(record);
        throw error instanceof BrowserCaptureError ? error : new BrowserCaptureError('assembly_failed', 'Capture assembly failed. Retry with the uploaded chunks.', true);
      }
    });
  }
}
