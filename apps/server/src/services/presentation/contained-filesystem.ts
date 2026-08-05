import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

export interface ContainedDirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

export type ContainedOperation = 'source-read' | 'cache-read' | 'cache-write' | 'ensure-directory';
export type ContainedOperationStage = 'ready' | 'prepared' | 'installed' | 'before-cleanup';

export interface ContainedOperationEvent {
  operation: ContainedOperation;
  stage: ContainedOperationStage;
  directoryPath: string;
  namespacePath?: string;
  temporaryPath?: string;
  targetPath?: string;
}

export interface ContainedRuntimeOptions {
  onEvent?: (event: ContainedOperationEvent) => Promise<void> | void;
  timeoutMs?: number;
  terminationGraceMs?: number;
  childBehavior?: {
    hangAfterReady?: boolean;
    ignoreSigterm?: boolean;
  };
}

export const MAX_CONTAINED_HELPERS = 2;
export const CONTAINED_HELPER_TIMEOUT_MS = 15_000;
export const CONTAINED_HELPER_TERMINATION_GRACE_MS = 250;

const MAX_PROTOCOL_OUTPUT_BYTES = 17 * 1024 * 1024;

let activePermits = 0;
const permitQueue: Array<() => void> = [];
let activeProcesses = 0;
let maxActiveProcesses = 0;
let spawned = 0;

async function acquirePermit(): Promise<void> {
  if (activePermits < MAX_CONTAINED_HELPERS) {
    activePermits += 1;
    return;
  }
  await new Promise<void>((resolve) => permitQueue.push(resolve));
}

function releasePermit(): void {
  const next = permitQueue.shift();
  if (next) next();
  else activePermits -= 1;
}

export function inspectContainedFilesystemResources(): {
  activePermits: number;
  activeProcesses: number;
  maxActiveProcesses: number;
  queued: number;
  spawned: number;
} {
  return {
    activePermits,
    activeProcesses,
    maxActiveProcesses,
    queued: permitQueue.length,
    spawned,
  };
}

export function resetContainedFilesystemMetricsForTests(): void {
  if (activePermits !== 0 || activeProcesses !== 0 || permitQueue.length !== 0) {
    throw new Error('contained filesystem resources are active');
  }
  maxActiveProcesses = 0;
  spawned = 0;
}

// Node does not expose openat/renameat. A child whose cwd has already been
// resolved by the kernel holds an equivalent stable directory reference. The
// child validates that cwd and performs only relative, no-follow operations.
// Cache finalization uses synchronous syscalls so test hooks are the only
// deliberate yield points inside the private namespace/install transaction.
const CONTAINED_FILESYSTEM_CHILD = String.raw`
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

const fail = () => process.exit(1);
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const safeName = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 255
  && value !== '.'
  && value !== '..'
  && !value.includes('/')
  && !value.includes('\\')
  && !value.includes('\0');
const optionalLstat = (target) => {
  try { return lstatSync(target, { bigint: true }); } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
};
const emit = (payload, wait = true) => {
  writeSync(3, JSON.stringify(payload) + '\n');
  if (!wait) return;
  const acknowledgement = Buffer.allocUnsafe(1);
  if (readSync(4, acknowledgement, 0, 1, null) !== 1) fail();
};
const readInput = (maxBytes) => {
  const chunks = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
  while (true) {
    const count = readSync(0, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) fail();
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
};
const writeAll = (fd, bytes) => {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
};
const hashDescriptor = (fd, size, maxBytes) => {
  if (size < 0n || size > BigInt(maxBytes)) throw new Error('invalid installed size');
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < Number(size)) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.byteLength, Number(size) - offset), offset);
    if (count === 0) throw new Error('short installed read');
    hash.update(chunk.subarray(0, count));
    offset += count;
  }
  const probe = Buffer.allocUnsafe(1);
  if (readSync(fd, probe, 0, 1, Number(size)) !== 0) throw new Error('installed file grew');
  return hash.digest('hex');
};

const [
  operation,
  expectedDev,
  expectedIno,
  name,
  first,
  second,
  third,
  ignoreSigterm,
  hangAfterReady,
  enableTestStages,
] = process.argv.slice(1);
if (ignoreSigterm === '1') process.on('SIGTERM', () => undefined);
const hang = async () => {
  const interval = setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
  clearInterval(interval);
};

try {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') fail();
  if (!safeName(name)) fail();
  const cwdFd = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const cwdStat = fstatSync(cwdFd, { bigint: true });
  if (!cwdStat.isDirectory() || cwdStat.dev.toString() !== expectedDev || cwdStat.ino.toString() !== expectedIno) {
    fail();
  }

  if (operation === 'read') {
    const maxBytes = Number(first);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail();
    const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)) fail();
    emit({ stage: 'ready' });
    if (hangAfterReady === '1') await hang();
    const length = Number(before.size);
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, offset);
      if (count === 0) fail();
      offset += count;
    }
    const probe = Buffer.allocUnsafe(1);
    const overflow = readSync(fd, probe, 0, 1, length);
    const after = fstatSync(fd, { bigint: true });
    if (
      overflow !== 0
      || !same(after, before)
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) fail();
    closeSync(fd);
    closeSync(cwdFd);
    writeSync(1, bytes);
  } else if (operation === 'atomic-write') {
    const namespace = first;
    const maxBytes = Number(second);
    const expectedHash = third;
    if (!safeName(namespace) || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      fail();
    }
    emit({ stage: 'ready' });
    if (hangAfterReady === '1') await hang();
    const bytes = readInput(maxBytes);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) fail();

    const temporary = namespace + '/candidate';
    const backup = namespace + '/previous';
    const quarantine = namespace + '/rejected';
    let namespaceIdentity;
    let temporaryIdentity;
    let previousIdentity;
    let candidateFd;
    let installed = false;
    let completed = false;
    try {
      mkdirSync(namespace, { mode: 0o700 });
      const namespaceStat = lstatSync(namespace, { bigint: true });
      if (!namespaceStat.isDirectory() || namespaceStat.isSymbolicLink() || (namespaceStat.mode & 0o777n) !== 0o700n) {
        throw new Error('private namespace invalid');
      }
      namespaceIdentity = { dev: namespaceStat.dev, ino: namespaceStat.ino };
      candidateFd = openSync(
        temporary,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(candidateFd, 0o600);
      writeAll(candidateFd, bytes);
      fsyncSync(candidateFd);
      const candidateStat = fstatSync(candidateFd, { bigint: true });
      temporaryIdentity = { dev: candidateStat.dev, ino: candidateStat.ino };
      if (
        !candidateStat.isFile()
        || candidateStat.isSymbolicLink()
        || (candidateStat.mode & 0o777n) !== 0o600n
        || hashDescriptor(candidateFd, candidateStat.size, maxBytes) !== expectedHash
      ) throw new Error('candidate invalid');

      if (enableTestStages === '1') emit({ stage: 'prepared', namespace, temporary });
      const namedCandidate = lstatSync(temporary, { bigint: true });
      if (!namedCandidate.isFile() || namedCandidate.isSymbolicLink() || !same(namedCandidate, temporaryIdentity)) {
        throw new Error('candidate name replaced');
      }

      const previous = optionalLstat(name);
      if (previous) {
        if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('target is not replaceable');
        previousIdentity = { dev: previous.dev, ino: previous.ino };
        renameSync(name, backup);
      }
      renameSync(temporary, name);
      installed = true;
      if (enableTestStages === '1') emit({ stage: 'installed', namespace, temporary, target: name });

      const installedFd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW);
      const installedStat = fstatSync(installedFd, { bigint: true });
      const namedInstalled = lstatSync(name, { bigint: true });
      const installedHash = hashDescriptor(installedFd, installedStat.size, maxBytes);
      closeSync(installedFd);
      if (
        !installedStat.isFile()
        || installedStat.isSymbolicLink()
        || !same(installedStat, temporaryIdentity)
        || !same(namedInstalled, temporaryIdentity)
        || installedHash !== expectedHash
      ) throw new Error('installed target invalid');
      fsyncSync(cwdFd);

      if (previousIdentity) {
        const namedBackup = lstatSync(backup, { bigint: true });
        if (!same(namedBackup, previousIdentity)) throw new Error('backup identity changed');
        unlinkSync(backup);
      }
      closeSync(candidateFd);
      candidateFd = undefined;
      const currentNamespace = lstatSync(namespace, { bigint: true });
      if (!same(currentNamespace, namespaceIdentity)) throw new Error('namespace identity changed');
      rmdirSync(namespace);
      fsyncSync(cwdFd);
      closeSync(cwdFd);
      completed = true;
    } catch {
      if (enableTestStages === '1') emit({ stage: 'before-cleanup', namespace, temporary, target: name });
      if (candidateFd !== undefined) {
        try { closeSync(candidateFd); } catch {}
      }
      const currentTarget = optionalLstat(name);
      if (installed && currentTarget && temporaryIdentity && same(currentTarget, temporaryIdentity)) {
        try { renameSync(name, quarantine); } catch {}
      }
      const currentBackup = optionalLstat(backup);
      if (previousIdentity && currentBackup && same(currentBackup, previousIdentity) && !optionalLstat(name)) {
        try { renameSync(backup, name); } catch {}
      }
      const currentTemporary = optionalLstat(temporary);
      if (temporaryIdentity && currentTemporary && same(currentTemporary, temporaryIdentity)) {
        try { unlinkSync(temporary); } catch {}
      }
      const currentNamespace = optionalLstat(namespace);
      if (namespaceIdentity && currentNamespace && same(currentNamespace, namespaceIdentity)) {
        try { rmdirSync(namespace); } catch {}
      }
      try { fsyncSync(cwdFd); } catch {}
    }
    if (!completed) fail();
  } else if (operation === 'ensure-directory') {
    emit({ stage: 'ready' });
    if (hangAfterReady === '1') await hang();
    try { mkdirSync(name, { mode: 0o700 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const fd = openSync(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fchmodSync(fd, 0o700);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) fail();
    closeSync(cwdFd);
    writeSync(1, JSON.stringify({ dev: stat.dev.toString(), ino: stat.ino.toString() }));
    closeSync(fd);
  } else {
    fail();
  }
} catch (error) {
  if (error?.code === 'ENOENT') {
    emit({ stage: 'error', code: 'ENOENT' }, false);
    process.exit(0);
  }
  fail();
}
`;

interface ChildEventPayload {
  stage?: unknown;
  code?: unknown;
  namespace?: unknown;
  temporary?: unknown;
  target?: unknown;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function safeDuration(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= 60_000 ? value! : fallback;
}

async function collect(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Buffer);
    total += bytes.byteLength;
    if (total > maxBytes) throw new Error('contained filesystem output exceeded cap');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function eventReader(stream: Readable): {
  next(): Promise<ChildEventPayload | undefined>;
  close(): void;
} {
  const queued: ChildEventPayload[] = [];
  const waiters: Array<(value: ChildEventPayload | undefined) => void> = [];
  let pending = '';
  let ended = false;
  const flush = () => {
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let parsed: ChildEventPayload;
      try {
        parsed = JSON.parse(line) as ChildEventPayload;
      } catch {
        parsed = { stage: 'invalid' };
      }
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queued.push(parsed);
    }
  };
  const onData = (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    flush();
  };
  const onEnd = () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(undefined);
  };
  stream.on('data', onData);
  stream.once('end', onEnd);
  return {
    next() {
      const queuedEvent = queued.shift();
      if (queuedEvent) return Promise.resolve(queuedEvent);
      if (ended) return Promise.resolve(undefined);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      stream.off('data', onData);
      stream.off('end', onEnd);
      ended = true;
      while (waiters.length > 0) waiters.shift()!(undefined);
    },
  };
}

function mapEvent(
  directory: ContainedDirectoryIdentity,
  operation: ContainedOperation,
  payload: ChildEventPayload,
): ContainedOperationEvent {
  const stage = payload.stage;
  if (!['ready', 'prepared', 'installed', 'before-cleanup'].includes(String(stage))) {
    throw new Error('contained filesystem child sent an invalid event');
  }
  return {
    operation,
    stage: stage as ContainedOperationStage,
    directoryPath: directory.path,
    namespacePath:
      typeof payload.namespace === 'string'
        ? path.join(directory.path, payload.namespace)
        : undefined,
    temporaryPath:
      typeof payload.temporary === 'string'
        ? path.join(directory.path, payload.temporary)
        : undefined,
    targetPath:
      typeof payload.target === 'string' ? path.join(directory.path, payload.target) : undefined,
  };
}

function trackedExit(child: ChildProcess): {
  promise: Promise<number | null>;
  hasExited(): boolean;
  close(): void;
} {
  let exited = false;
  let settle!: (code: number | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<number | null>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  const onClose = (code: number | null) => {
    if (exited) return;
    exited = true;
    activeProcesses -= 1;
    settle(code);
  };
  const onError = (error: Error) => {
    if (exited) return;
    exited = true;
    activeProcesses -= 1;
    reject(error);
  };
  child.once('close', onClose);
  child.once('error', onError);
  return {
    promise,
    hasExited: () => exited,
    close() {
      child.off('close', onClose);
      child.off('error', onError);
    },
  };
}

async function terminateAndReap(
  child: ChildProcess,
  exit: ReturnType<typeof trackedExit>,
  graceMs: number,
): Promise<void> {
  if (exit.hasExited()) {
    await exit.promise.catch(() => undefined);
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([exit.promise.catch(() => undefined), delay(graceMs)]);
  if (!exit.hasExited()) child.kill('SIGKILL');
  await exit.promise.catch(() => undefined);
}

async function runContainedChild(
  directory: ContainedDirectoryIdentity,
  operation: ContainedOperation,
  childOperation: 'read' | 'atomic-write' | 'ensure-directory',
  args: string[],
  input: Buffer,
  maxOutputBytes: number,
  options: ContainedRuntimeOptions = {},
): Promise<Buffer> {
  await acquirePermit();
  let child: ChildProcess | undefined;
  let exit: ReturnType<typeof trackedExit> | undefined;
  let events: ReturnType<typeof eventReader> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        CONTAINED_FILESYSTEM_CHILD,
        childOperation,
        directory.dev.toString(),
        directory.ino.toString(),
        ...args,
        options.childBehavior?.ignoreSigterm ? '1' : '0',
        options.childBehavior?.hangAfterReady ? '1' : '0',
        options.onEvent ? '1' : '0',
      ],
      {
        cwd: directory.path,
        env: {},
        stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    spawned += 1;
    activeProcesses += 1;
    maxActiveProcesses = Math.max(maxActiveProcesses, activeProcesses);
    exit = trackedExit(child);
    const stdin = child.stdin;
    const stdout = child.stdout;
    const eventStream = child.stdio[3] as Readable | null;
    const control = child.stdio[4] as Writable | null;
    if (!stdin || !stdout || !eventStream || !control) {
      throw new Error('contained filesystem pipes were unavailable');
    }
    events = eventReader(eventStream);
    const output = collect(stdout, Math.min(maxOutputBytes + 1, MAX_PROTOCOL_OUTPUT_BYTES));
    const timeoutMs = safeDuration(options.timeoutMs, CONTAINED_HELPER_TIMEOUT_MS);
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('contained filesystem child timed out')),
        timeoutMs,
      );
      timeout.unref?.();
    });
    const beforeDeadline = <T>(promise: Promise<T>) => Promise.race([promise, deadline]);
    let inputSent = false;
    let protocolError: Error | undefined;

    while (true) {
      const outcome = await beforeDeadline(
        Promise.race([
          events.next().then((event) => ({ kind: 'event' as const, event })),
          exit.promise.then((code) => ({ kind: 'exit' as const, code })),
        ]),
      );
      if (outcome.kind === 'exit') {
        if (outcome.code !== 0) throw new Error('contained filesystem child failed');
        break;
      }
      if (!outcome.event) {
        const code = await beforeDeadline(exit.promise);
        if (code !== 0) throw new Error('contained filesystem child failed');
        break;
      }
      if (outcome.event.stage === 'error') {
        protocolError = Object.assign(new Error('contained file does not exist'), {
          code: String(outcome.event.code),
        });
        continue;
      }
      const event = mapEvent(directory, operation, outcome.event);
      if (event.stage === 'ready' && !inputSent) {
        stdin.end(input);
        inputSent = true;
      }
      if (options.onEvent) {
        const hook = Promise.resolve().then(() => options.onEvent!(event));
        void hook.catch(() => undefined);
        await beforeDeadline(hook);
      }
      control.write(Buffer.from([1]));
    }
    clearTimeout(timeout);
    timeout = undefined;
    const allOutput = await output;
    if (protocolError) throw protocolError;
    return allOutput;
  } catch (error) {
    if (child && exit)
      await terminateAndReap(
        child,
        exit,
        safeDuration(options.terminationGraceMs, CONTAINED_HELPER_TERMINATION_GRACE_MS),
      );
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    events?.close();
    exit?.close();
    child?.stdin?.destroy();
    (child?.stdio[4] as Writable | null | undefined)?.destroy();
    releasePermit();
  }
}

export async function readContainedFile(
  directory: ContainedDirectoryIdentity,
  name: string,
  maxBytes: number,
  operation: 'source-read' | 'cache-read',
  options: ContainedRuntimeOptions = {},
): Promise<Buffer> {
  return runContainedChild(
    directory,
    operation,
    'read',
    [name, String(maxBytes), '', ''],
    Buffer.alloc(0),
    maxBytes,
    options,
  );
}

export async function atomicWriteContainedFile(
  directory: ContainedDirectoryIdentity,
  name: string,
  data: Buffer,
  maxBytes: number,
  options: ContainedRuntimeOptions = {},
): Promise<void> {
  const namespace = `.slide-cache-${randomUUID()}`;
  const expectedHash = createHash('sha256').update(data).digest('hex');
  await runContainedChild(
    directory,
    'cache-write',
    'atomic-write',
    [name, namespace, String(maxBytes), expectedHash],
    data,
    0,
    options,
  );
}

export async function ensureContainedDirectory(
  directory: ContainedDirectoryIdentity,
  name: string,
  options: ContainedRuntimeOptions = {},
): Promise<ContainedDirectoryIdentity> {
  const output = await runContainedChild(
    directory,
    'ensure-directory',
    'ensure-directory',
    [name, '', '', ''],
    Buffer.alloc(0),
    128,
    options,
  );
  const parsed = JSON.parse(output.toString('utf8')) as { dev?: unknown; ino?: unknown };
  if (typeof parsed.dev !== 'string' || typeof parsed.ino !== 'string') {
    throw new Error('contained directory identity was invalid');
  }
  return {
    path: path.join(directory.path, name),
    dev: BigInt(parsed.dev),
    ino: BigInt(parsed.ino),
  };
}
