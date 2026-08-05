import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';

export interface ContainedDirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

export type ContainedOperation = 'source-read' | 'cache-read' | 'cache-write' | 'ensure-directory';

const CHILD_TIMEOUT_MS = 15_000;
const MAX_PROTOCOL_OUTPUT_BYTES = 17 * 1024 * 1024;

// Node does not expose openat/renameat. A child whose cwd has already been
// resolved by the kernel holds the equivalent stable directory reference even
// if the cwd pathname is later renamed. The child verifies that reference by
// dev/ino before touching a relative basename and then uses no-follow handles.
const CONTAINED_FILESYSTEM_CHILD = String.raw`
import { constants, writeSync } from 'node:fs';
import { open, lstat, mkdir, rename, unlink } from 'node:fs/promises';

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
const readInput = async (maxBytes) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.byteLength;
    if (total > maxBytes) fail();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
};
const ready = () => writeSync(3, Buffer.from([0]));

try {
  const [operation, expectedDev, expectedIno, name, first, second] = process.argv.slice(1);
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') fail();
  if (!safeName(name)) fail();
  const cwd = await open('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const cwdStat = await cwd.stat({ bigint: true });
  if (!cwdStat.isDirectory() || cwdStat.dev.toString() !== expectedDev || cwdStat.ino.toString() !== expectedIno) {
    fail();
  }

  if (operation === 'read') {
    const maxBytes = Number(first);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail();
    const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)) fail();
    ready();
    await readInput(0);
    const length = Number(before.size);
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(bytes, offset, length - offset, offset);
      if (result.bytesRead === 0) fail();
      offset += result.bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const overflow = await handle.read(probe, 0, 1, length);
    const after = await handle.stat({ bigint: true });
    if (
      overflow.bytesRead !== 0
      || !same(after, before)
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
    ) fail();
    await handle.close();
    await cwd.close();
    process.stdout.write(bytes);
  } else if (operation === 'atomic-write') {
    const temporary = first;
    const maxBytes = Number(second);
    if (!safeName(temporary) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) fail();
    ready();
    const bytes = await readInput(maxBytes);
    let handle;
    let identity;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      const created = await handle.stat({ bigint: true });
      identity = { dev: created.dev, ino: created.ino };
      const named = await lstat(temporary, { bigint: true });
      if (!created.isFile() || created.isSymbolicLink() || (created.mode & 0o777n) !== 0o600n || !same(created, named)) {
        throw new Error('owned temporary identity changed');
      }
      await rename(temporary, name);
      const installed = await lstat(name, { bigint: true });
      if (!installed.isFile() || installed.isSymbolicLink() || !same(installed, identity)) {
        throw new Error('installed target identity changed');
      }
      await cwd.sync();
      await handle.close();
      await cwd.close();
    } catch {
      if (handle) await handle.close().catch(() => undefined);
      if (identity) {
        const current = await lstat(temporary, { bigint: true }).catch(() => undefined);
        if (current && same(current, identity)) await unlink(temporary).catch(() => undefined);
      }
      fail();
    }
  } else if (operation === 'ensure-directory') {
    ready();
    await readInput(0);
    await mkdir(name, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.chmod(0o700);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || (stat.mode & 0o777n) !== 0o700n) fail();
    await cwd.close();
    process.stdout.write(JSON.stringify({ dev: stat.dev.toString(), ino: stat.ino.toString() }));
    await handle.close();
  } else {
    fail();
  }
} catch (error) {
  if (error?.code === 'ENOENT') {
    writeSync(3, Buffer.from([2]));
    process.exit(0);
  }
  fail();
}
`;

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

async function runContainedChild(
  directory: ContainedDirectoryIdentity,
  operation: ContainedOperation,
  childOperation: 'read' | 'atomic-write' | 'ensure-directory',
  args: string[],
  input: Buffer,
  maxOutputBytes: number,
  onReady?: (operation: ContainedOperation) => Promise<void> | void,
): Promise<Buffer> {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    CONTAINED_FILESYSTEM_CHILD,
    childOperation,
    directory.dev.toString(),
    directory.ino.toString(),
    ...args,
  ], {
    cwd: directory.path,
    env: {},
    stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  const readiness = child.stdio[3] as Readable | null;
  if (!stdin || !stdout || !readiness) {
    child.kill();
    throw new Error('contained filesystem pipes were unavailable');
  }
  const output = collect(stdout, Math.min(maxOutputBytes + 1, MAX_PROTOCOL_OUTPUT_BYTES));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const timeout = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const first = await new Promise<Buffer>((resolve, reject) => {
      readiness.once('data', (chunk) => resolve(Buffer.from(chunk)));
      readiness.once('end', () => reject(new Error('contained filesystem child ended before ready')));
    });
    if (first.byteLength === 0) throw new Error('contained filesystem child failed readiness');
    if (first[0] === 2) {
      throw Object.assign(new Error('contained file does not exist'), { code: 'ENOENT' });
    }
    if (first[0] !== 0) throw new Error('contained filesystem child failed readiness');
    await onReady?.(operation);
    stdin.end(input);
    const [allOutput, code] = await Promise.all([output, exit]);
    if (code !== 0) {
      throw new Error('contained filesystem child failed');
    }
    return allOutput;
  } catch (error) {
    stdin.destroy();
    child.kill();
    await exit.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readContainedFile(
  directory: ContainedDirectoryIdentity,
  name: string,
  maxBytes: number,
  operation: 'source-read' | 'cache-read',
  onReady?: (operation: ContainedOperation) => Promise<void> | void,
): Promise<Buffer> {
  return runContainedChild(
    directory,
    operation,
    'read',
    [name, String(maxBytes)],
    Buffer.alloc(0),
    maxBytes,
    onReady,
  );
}

export async function atomicWriteContainedFile(
  directory: ContainedDirectoryIdentity,
  name: string,
  temporary: string,
  data: Buffer,
  maxBytes: number,
  onReady?: (operation: ContainedOperation) => Promise<void> | void,
): Promise<void> {
  await runContainedChild(
    directory,
    'cache-write',
    'atomic-write',
    [name, temporary, String(maxBytes)],
    data,
    0,
    onReady,
  );
}

export async function ensureContainedDirectory(
  directory: ContainedDirectoryIdentity,
  name: string,
  onReady?: (operation: ContainedOperation) => Promise<void> | void,
): Promise<ContainedDirectoryIdentity> {
  const output = await runContainedChild(
    directory,
    'ensure-directory',
    'ensure-directory',
    [name],
    Buffer.alloc(0),
    128,
    onReady,
  );
  const parsed = JSON.parse(output.toString('utf8')) as { dev?: unknown; ino?: unknown };
  if (typeof parsed.dev !== 'string' || typeof parsed.ino !== 'string') {
    throw new Error('contained directory identity was invalid');
  }
  return { path: path.join(directory.path, name), dev: BigInt(parsed.dev), ino: BigInt(parsed.ino) };
}
