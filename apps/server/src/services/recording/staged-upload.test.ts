import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageUploadStream } from './staged-upload.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stagingRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vpa-stage-test-'));
  roots.push(root);
  return root;
}

describe('staged upload streaming', () => {
  it('writes each chunk before requesting the next chunk from a large logical stream', async () => {
    const root = await stagingRoot();
    const destination = path.join(root, 'large.upload');
    const chunkSize = 64 * 1024;
    const chunkCount = 128;
    async function* chunks() {
      for (let index = 0; index < chunkCount; index += 1) {
        if (index > 0) {
          expect((await stat(destination)).size).toBe(index * chunkSize);
        }
        yield Buffer.alloc(chunkSize, index % 251);
      }
    }

    const staged = await stageUploadStream(destination, chunks(), 16 * 1024 * 1024);

    expect(staged).toEqual({ path: destination, sizeBytes: chunkSize * chunkCount });
    expect((await stat(destination)).size).toBe(8 * 1024 * 1024);
  });

  it('removes a partial file when cumulative chunks exceed the byte limit', async () => {
    const root = await stagingRoot();
    const destination = path.join(root, 'bounded.upload');

    await expect(stageUploadStream(
      destination,
      (async function* () {
        yield Buffer.from('123456');
        yield Buffer.from('78901');
      })(),
      10,
    )).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a partial file when its source stream fails', async () => {
    const root = await stagingRoot();
    const destination = path.join(root, 'failed.upload');

    await expect(stageUploadStream(
      destination,
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('source aborted');
      })(),
      1024,
    )).rejects.toThrow('source aborted');
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});
