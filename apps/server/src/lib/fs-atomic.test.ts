import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './fs-atomic.js';

describe('atomicWriteFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vpa-atomic-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes new file', async () => {
    const target = path.join(dir, 'out.txt');
    await atomicWriteFile(target, 'hello');
    expect(await readFile(target, 'utf8')).toBe('hello');
  });

  it('replaces existing file atomically', async () => {
    const target = path.join(dir, 'out.txt');
    await writeFile(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('creates parent directory if missing', async () => {
    const target = path.join(dir, 'sub', 'nested', 'out.txt');
    await atomicWriteFile(target, 'deep');
    expect(await readFile(target, 'utf8')).toBe('deep');
  });
});
