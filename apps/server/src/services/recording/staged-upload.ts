import { mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const BULK_UPLOAD_STAGING_PREFIX = 'vpa-recording-upload-';
export const BULK_UPLOAD_MAX_FILES = 10;
export const BULK_UPLOAD_MAX_FILE_BYTES = 500 * 1024 * 1024;

export class StagedUploadError extends Error {
  constructor(
    public readonly code: 'file_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'StagedUploadError';
  }
}

export interface StagedUpload {
  path: string;
  sizeBytes: number;
}

export async function stageUploadStream(
  destination: string,
  source: AsyncIterable<Buffer | Uint8Array>,
  maxBytes: number,
): Promise<StagedUpload> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Upload byte limit must be a positive safe integer.');
  }
  const file = await open(destination, 'wx', 0o600);
  let sizeBytes = 0;
  let closed = false;
  try {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.byteLength > maxBytes - sizeBytes) {
        throw new StagedUploadError('file_too_large', 'Uploaded file exceeds the byte limit.');
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error('Staged upload write made no progress.');
        offset += bytesWritten;
      }
      sizeBytes += chunk.byteLength;
    }
    await file.close();
    closed = true;
    return { path: destination, sizeBytes };
  } catch (error) {
    if (!closed) {
      await file.close().catch(() => undefined);
      closed = true;
    }
    await unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    if (!closed) await file.close().catch(() => undefined);
  }
}

export function createBulkUploadStagingDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), BULK_UPLOAD_STAGING_PREFIX));
}

export function cleanupBulkUploadStagingDirectory(directory: string): Promise<void> {
  return rm(directory, { recursive: true, force: true });
}
