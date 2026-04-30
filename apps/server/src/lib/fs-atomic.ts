import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Write `data` to `target` atomically: write to a sibling tmp file, then rename.
 * Creates parent directories as needed. Safe against partial writes on crash.
 */
export async function atomicWriteFile(target: string, data: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(tmp, data, { encoding: 'utf8' });
  await rename(tmp, target);
}
