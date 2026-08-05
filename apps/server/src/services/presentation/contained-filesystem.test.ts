import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CONTAINED_HELPERS,
  atomicWriteContainedFile,
  inspectContainedFilesystemResources,
  readContainedFile,
  resetContainedFilesystemMetricsForTests,
  type ContainedDirectoryIdentity,
  type ContainedOperationEvent,
} from './contained-filesystem.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('contained filesystem helper', () => {
  let directoryPath: string;
  let directory: ContainedDirectoryIdentity;

  beforeEach(async () => {
    directoryPath = await mkdtemp(path.join(tmpdir(), 'vpa-contained-fs-'));
    const identity = await stat(directoryPath, { bigint: true });
    directory = { path: directoryPath, dev: identity.dev, ino: identity.ino };
    resetContainedFilesystemMetricsForTests();
  });

  afterEach(async () => {
    await rm(directoryPath, { recursive: true, force: true });
  });

  it('fairly limits every helper spawn to the explicit module-wide maximum', async () => {
    await writeFile(path.join(directoryPath, 'source.bin'), Buffer.from('bounded source'));
    const gate = deferred();
    const calls = Array.from({ length: 7 }, () =>
      readContainedFile(directory, 'source.bin', 1_024, 'source-read', {
        onEvent: () => gate.promise,
      }),
    );

    await vi.waitFor(() =>
      expect(inspectContainedFilesystemResources()).toMatchObject({
        activePermits: MAX_CONTAINED_HELPERS,
        activeProcesses: MAX_CONTAINED_HELPERS,
        maxActiveProcesses: MAX_CONTAINED_HELPERS,
        queued: 7 - MAX_CONTAINED_HELPERS,
      }),
    );
    gate.resolve();

    await expect(Promise.all(calls)).resolves.toEqual(Array(7).fill(Buffer.from('bounded source')));
    expect(inspectContainedFilesystemResources()).toEqual({
      activePermits: 0,
      activeProcesses: 0,
      maxActiveProcesses: MAX_CONTAINED_HELPERS,
      queued: 0,
      spawned: 7,
    });
  });

  it('times out and releases its permit when an event hook never settles', async () => {
    await writeFile(path.join(directoryPath, 'source.bin'), Buffer.from('bounded source'));
    const startedAt = Date.now();

    await expect(
      readContainedFile(directory, 'source.bin', 1_024, 'source-read', {
        timeoutMs: 80,
        terminationGraceMs: 40,
        onEvent: () => new Promise<void>(() => undefined),
      }),
    ).rejects.toThrow();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(inspectContainedFilesystemResources()).toMatchObject({
      activePermits: 0,
      activeProcesses: 0,
      queued: 0,
    });
  });

  it('includes queued permit time in the deadline and never spawns an expired waiter', async () => {
    await writeFile(path.join(directoryPath, 'source.bin'), Buffer.from('bounded source'));
    const gate = deferred();
    const blockers = Array.from({ length: MAX_CONTAINED_HELPERS }, () =>
      readContainedFile(directory, 'source.bin', 1_024, 'source-read', {
        timeoutMs: 2_000,
        onEvent: () => gate.promise,
      }),
    );
    await vi.waitFor(() =>
      expect(inspectContainedFilesystemResources()).toMatchObject({
        activePermits: MAX_CONTAINED_HELPERS,
        activeProcesses: MAX_CONTAINED_HELPERS,
        spawned: MAX_CONTAINED_HELPERS,
      }),
    );

    const expired = readContainedFile(directory, 'source.bin', 1_024, 'source-read', {
      timeoutMs: 80,
    });
    const outcome = await Promise.race([
      expired.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 250)),
    ]);

    gate.resolve();
    await Promise.all(blockers);
    await Promise.allSettled([expired]);

    expect(outcome).toBe('rejected');
    expect(inspectContainedFilesystemResources()).toEqual({
      activePermits: 0,
      activeProcesses: 0,
      maxActiveProcesses: MAX_CONTAINED_HELPERS,
      queued: 0,
      spawned: MAX_CONTAINED_HELPERS,
    });
  });

  it('escalates to SIGKILL and reaps a child that ignores SIGTERM', async () => {
    const startedAt = Date.now();

    await expect(
      atomicWriteContainedFile(directory, 'cache.json', Buffer.from('bounded cache'), 1_024, {
        timeoutMs: 500,
        terminationGraceMs: 40,
        childBehavior: { hangAfterReady: true, ignoreSigterm: true },
      }),
    ).rejects.toThrow();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(520);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await readdir(directoryPath)).toEqual([]);
    expect(inspectContainedFilesystemResources()).toMatchObject({
      activePermits: 0,
      activeProcesses: 0,
      queued: 0,
    });
  });

  it('never installs a temp replacement prepared between identity capture and install', async () => {
    const targetPath = path.join(directoryPath, 'cache.json');
    await writeFile(targetPath, 'previous valid cache', { mode: 0o600 });
    let replacementPath = '';
    const onEvent = async (event: ContainedOperationEvent) => {
      if (event.stage !== 'prepared') return;
      replacementPath = event.temporaryPath!;
      await unlink(replacementPath);
      await writeFile(replacementPath, 'non-owned replacement', { mode: 0o600 });
    };

    await expect(
      atomicWriteContainedFile(directory, 'cache.json', Buffer.from('new cache'), 1_024, {
        onEvent,
      }),
    ).rejects.toThrow();

    await expect(readFile(targetPath, 'utf8')).resolves.toBe('previous valid cache');
    await expect(readFile(replacementPath, 'utf8')).resolves.toBe('non-owned replacement');
  });

  it('never removes a temp replacement during failed-install cleanup', async () => {
    await mkdir(path.join(directoryPath, 'cache.json'));
    await writeFile(path.join(directoryPath, 'cache.json', 'marker.txt'), 'must survive');
    let replacementPath = '';
    const onEvent = async (event: ContainedOperationEvent) => {
      if (event.stage !== 'before-cleanup') return;
      replacementPath = event.temporaryPath!;
      await unlink(replacementPath);
      await writeFile(replacementPath, 'cleanup replacement', { mode: 0o600 });
    };

    await expect(
      atomicWriteContainedFile(directory, 'cache.json', Buffer.from('new cache'), 1_024, {
        onEvent,
      }),
    ).rejects.toThrow();

    await expect(
      readFile(path.join(directoryPath, 'cache.json', 'marker.txt'), 'utf8'),
    ).resolves.toBe('must survive');
    await expect(readFile(replacementPath, 'utf8')).resolves.toBe('cleanup replacement');
  });

  it('quarantines a post-install replacement and restores the previous valid cache', async () => {
    const targetPath = path.join(directoryPath, 'cache.json');
    await writeFile(targetPath, 'previous valid cache', { mode: 0o600 });
    let namespacePath = '';
    const onEvent = async (event: ContainedOperationEvent) => {
      if (event.stage !== 'installed') return;
      namespacePath = event.namespacePath!;
      await rename(targetPath, path.join(directoryPath, 'attacker-moved-installed'));
      await writeFile(targetPath, 'post-install replacement', { mode: 0o600 });
    };

    await expect(
      atomicWriteContainedFile(directory, 'cache.json', Buffer.from('new cache'), 1_024, {
        onEvent,
      }),
    ).rejects.toThrow();

    await expect(readFile(targetPath, 'utf8')).resolves.toBe('previous valid cache');
    const quarantined = await Promise.all(
      (await readdir(namespacePath)).map((entry) =>
        readFile(path.join(namespacePath, entry), 'utf8').catch(() => ''),
      ),
    );
    expect(quarantined).toContain('post-install replacement');
    await expect(readFile(path.join(directoryPath, 'attacker-moved-installed'), 'utf8')).resolves.toBe(
      'new cache',
    );
    await expect(
      readContainedFile(directory, 'cache.json', 1_024, 'cache-read'),
    ).resolves.toEqual(Buffer.from('previous valid cache'));
  });

  it('recovers a killed prepared transaction before the next cache read without residue', async () => {
    const targetPath = path.join(directoryPath, 'cache.json');
    await writeFile(targetPath, 'previous valid cache', { mode: 0o600 });

    let reachedPrepared = false;
    await expect(
      atomicWriteContainedFile(directory, 'cache.json', Buffer.from('new cache'), 1_024, {
        timeoutMs: 500,
        terminationGraceMs: 40,
        childBehavior: { ignoreSigterm: true },
        onEvent: (event) => {
          if (event.stage !== 'prepared') return;
          reachedPrepared = true;
          return new Promise<void>(() => undefined);
        },
      }),
    ).rejects.toThrow();

    expect(reachedPrepared).toBe(true);
    await expect(
      readContainedFile(directory, 'cache.json', 1_024, 'cache-read'),
    ).resolves.toEqual(Buffer.from('previous valid cache'));
    expect((await readdir(directoryPath)).filter((entry) => entry.startsWith('.slide-cache-'))).toEqual(
      [],
    );
  });

  it('rolls back a killed installed transaction before the next cache write', async () => {
    const targetPath = path.join(directoryPath, 'cache.json');
    await writeFile(targetPath, 'previous valid cache', { mode: 0o600 });

    let reachedInstalled = false;
    await expect(
      atomicWriteContainedFile(directory, 'cache.json', Buffer.from('interrupted cache'), 1_024, {
        timeoutMs: 500,
        terminationGraceMs: 40,
        childBehavior: { ignoreSigterm: true },
        onEvent: (event) => {
          if (event.stage !== 'installed') return;
          reachedInstalled = true;
          return new Promise<void>(() => undefined);
        },
      }),
    ).rejects.toThrow();

    expect(reachedInstalled).toBe(true);
    await atomicWriteContainedFile(directory, 'cache.json', Buffer.from('next valid cache'), 1_024);

    await expect(readFile(targetPath, 'utf8')).resolves.toBe('next valid cache');
    expect((await readdir(directoryPath)).filter((entry) => entry.startsWith('.slide-cache-'))).toEqual(
      [],
    );
  });
});
