import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  AssetManifestSchema,
  AssetSchema,
  type Asset,
  type AssetManifest,
  type AssetMediaKind,
  type AssetSourceRole,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { projectFiles } from '../project/paths.js';
import { resolveSafeProjectPath } from '../project/safe-path.js';
import { probeVideo, type VideoMetadata } from '../recording/metadata.js';

export const ASSET_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const ASSET_MAX_VIDEO_DURATION_SEC = 20 * 60;

const supported = {
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
} as const;

const assetMutationTails = new Map<string, Promise<void>>();

export class AssetImportError extends Error {
  constructor(
    public readonly code: 'unsupported_media' | 'malformed_media' | 'file_too_large' | 'video_too_long',
    message: string,
  ) {
    super(message);
    this.name = 'AssetImportError';
  }
}

export interface ImportAssetOptions {
  originalName: string;
  captureSessionId?: string;
  sourceRole?: AssetSourceRole;
  timingOriginMs?: number;
  legacySource?: string;
  /** Trusted metadata from an immediately preceding ffprobe in an existing ingest flow. */
  validatedVideoMetadata?: VideoMetadata;
}

export interface AssetStoreOptions {
  probe?: typeof probeVideo;
  persist?: typeof atomicWriteFile;
  copy?: typeof copyFile;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function readHeader(filePath: string, bytes = 16): Promise<Buffer> {
  const handle = await import('node:fs/promises').then(({ open }) => open(filePath, 'r'));
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function validHeader(extension: keyof typeof supported, header: Buffer): boolean {
  if (extension === '.mp4') return header.length >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp';
  if (extension === '.webm') return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (extension === '.png') return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg' || extension === '.jpeg') return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (extension === '.wav') return header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WAVE';
  if (extension === '.mp3') {
    return header.subarray(0, 3).toString('ascii') === 'ID3' || (header.length >= 2 && header[0] === 0xff && (header[1]! & 0xe0) === 0xe0);
  }
  return false;
}

function emptyManifest(): AssetManifest {
  return { version: 1, assets: [] };
}

export class AssetStore {
  private readonly probe: typeof probeVideo;
  private readonly persist: typeof atomicWriteFile;
  private readonly copy: typeof copyFile;

  constructor(private readonly projectRoot: string, opts: AssetStoreOptions = {}) {
    this.probe = opts.probe ?? probeVideo;
    this.persist = opts.persist ?? atomicWriteFile;
    this.copy = opts.copy ?? copyFile;
  }

  async load(): Promise<AssetManifest> {
    try {
      return AssetManifestSchema.parse(JSON.parse(await readFile(projectFiles(this.projectRoot).assetManifest, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest();
      throw error;
    }
  }

  async list(): Promise<Asset[]> {
    return (await this.load()).assets;
  }

  async get(id: string): Promise<Asset | undefined> {
    return (await this.load()).assets.find((asset) => asset.id === id);
  }

  async importFile(sourcePath: string, options: ImportAssetOptions): Promise<Asset> {
    const key = path.resolve(this.projectRoot);
    const previous = assetMutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    assetMutationTails.set(key, current);
    await previous;
    try {
      return await this.importFileUnlocked(sourcePath, options);
    } finally {
      release();
      if (assetMutationTails.get(key) === current) assetMutationTails.delete(key);
    }
  }

  private async importFileUnlocked(sourcePath: string, options: ImportAssetOptions): Promise<Asset> {
    const extension = path.extname(options.originalName).toLowerCase() as keyof typeof supported;
    const support = supported[extension];
    if (!support) throw new AssetImportError('unsupported_media', 'Supported files are MP4, WebM, PNG, JPEG, MP3, and WAV.');

    const info = await stat(sourcePath);
    if (!info.isFile()) throw new AssetImportError('malformed_media', 'The selected source is not a file.');
    if (info.size > ASSET_MAX_BYTES) throw new AssetImportError('file_too_large', 'Files must be 2 GiB or smaller.');
    if (!(support.kind === 'video' && options.validatedVideoMetadata) && !validHeader(extension, await readHeader(sourcePath))) {
      throw new AssetImportError('malformed_media', 'The file contents do not match the selected media type.');
    }

    let metadata: VideoMetadata | undefined;
    if (support.kind === 'video') {
      try {
        metadata = options.validatedVideoMetadata ?? await this.probe(sourcePath);
      } catch {
        throw new AssetImportError('malformed_media', 'The video could not be read.');
      }
      if (metadata.duration_sec > ASSET_MAX_VIDEO_DURATION_SEC) {
        throw new AssetImportError('video_too_long', 'Videos must be 20 minutes or shorter.');
      }
    }

    const checksum = await sha256(sourcePath);
    const manifest = await this.load();
    const existing = manifest.assets.find((asset) => asset.checksum === checksum);
    if (existing) return existing;

    const files = projectFiles(this.projectRoot);
    await mkdir(files.assetOriginalsDir, { recursive: true });
    const relativeSource = `.vpa/assets/originals/${checksum}${extension === '.jpeg' ? '.jpg' : extension}`;
    const destination = await resolveSafeProjectPath(this.projectRoot, relativeSource);
    const temporary = `${destination}.importing`;
    await this.copy(sourcePath, temporary);
    try {
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const now = new Date().toISOString();
    const asset = AssetSchema.parse({
      id: `asset_${checksum}`,
      checksum,
      original_name: path.basename(options.originalName),
      source: relativeSource,
      origin: 'source',
      media_kind: support.kind as AssetMediaKind,
      mime_type: support.mime,
      size_bytes: info.size,
      imported_at: now,
      duration_sec: metadata?.duration_sec,
      width: metadata?.width,
      height: metadata?.height,
      timing_origin_ms: options.timingOriginMs ?? 0,
      capture_session_id: options.captureSessionId,
      source_role: options.sourceRole,
      legacy_source: options.legacySource,
      preparation: {
        status: 'ready',
        attempts: 1,
        updated_at: now,
        ...(support.kind === 'image' ? { thumbnail: relativeSource } : { proxy: relativeSource }),
      },
    });
    await this.persist(files.assetManifest, JSON.stringify(AssetManifestSchema.parse({
      version: 1,
      assets: [...manifest.assets, asset],
    }), null, 2));
    return asset;
  }

  async retryPreparation(id: string): Promise<Asset> {
    const manifest = await this.load();
    const index = manifest.assets.findIndex((asset) => asset.id === id);
    if (index < 0) throw new AssetImportError('malformed_media', 'The asset does not exist.');
    const current = manifest.assets[index]!;
    const absolute = await resolveSafeProjectPath(this.projectRoot, current.source);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new AssetImportError('malformed_media', 'The asset bytes are missing.');
    const updated = AssetSchema.parse({
      ...current,
      preparation: {
        ...current.preparation,
        status: 'ready',
        attempts: current.preparation.attempts + 1,
        updated_at: new Date().toISOString(),
        error: undefined,
      },
    });
    const assets = manifest.assets.map((asset, assetIndex) => assetIndex === index ? updated : asset);
    await this.persist(projectFiles(this.projectRoot).assetManifest, JSON.stringify({ version: 1, assets }, null, 2));
    return updated;
  }

  async registerLegacy(relativeSource: string, role: AssetSourceRole = 'screen'): Promise<Asset> {
    const absolute = await resolveSafeProjectPath(this.projectRoot, relativeSource);
    return this.importFile(absolute, {
      originalName: path.basename(relativeSource),
      sourceRole: role,
      legacySource: relativeSource,
    });
  }
}
