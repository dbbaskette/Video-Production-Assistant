/**
 * Storyboard snapshot history.
 *
 * Every saveStoryboard call records the pre-write contents to
 * <project>/.snapshots/<timestamp>.yaml before atomically overwriting
 * the live file. Keeps the last 30 (drops the oldest). Lets users undo
 * the cascading invalidations that script / lower-thirds / recording
 * saves trigger — see the destructive-save warning on the client side.
 *
 * Cheap insurance: storyboard YAML is small (typically <50 KB), and the
 * disk write is parallel to the main save. If a snapshot can't be
 * written (no current file, ENOSPC, …) we log and proceed — never block
 * the user's save.
 */

import { readFile, readdir, mkdir, unlink, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { projectFiles } from '../project/paths.js';

const KEEP_DEFAULT = 30;

/** Filenames look like `2026-05-27T15-04-22-123Z.yaml` — sortable. */
function isoToFilename(d: Date): string {
  return `${d.toISOString().replace(/[:.]/g, '-')}.yaml`;
}

function filenameToIso(name: string): string | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.yaml$/);
  if (!m) return null;
  return m[1]!.replace(/-(\d{2})-(\d{2})-(\d{3}Z)$/, ':$1:$2.$3').replace(/-(\d{2})(?=T)/, '-$1');
}

export interface SnapshotInfo {
  id: string; // filename without extension
  takenAt: string; // ISO
  sizeBytes: number;
}

export async function writeSnapshotFromCurrent(projectRoot: string): Promise<SnapshotInfo | null> {
  const files = projectFiles(projectRoot);
  let current: string;
  try {
    current = await readFile(files.storyboard, 'utf8');
  } catch (err) {
    // First-ever save: nothing to snapshot.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  await mkdir(files.snapshotsDir, { recursive: true });
  const filename = isoToFilename(new Date());
  const target = join(files.snapshotsDir, filename);
  await atomicWriteFile(target, current);
  return {
    id: filename.replace(/\.yaml$/, ''),
    takenAt: new Date().toISOString(),
    sizeBytes: Buffer.byteLength(current, 'utf8'),
  };
}

export async function pruneSnapshots(projectRoot: string, keep = KEEP_DEFAULT): Promise<number> {
  const files = projectFiles(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(files.snapshotsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const yamls = entries.filter((n) => n.endsWith('.yaml')).sort();
  if (yamls.length <= keep) return 0;
  const drop = yamls.slice(0, yamls.length - keep);
  await Promise.all(drop.map((n) => unlink(join(files.snapshotsDir, n)).catch(() => undefined)));
  return drop.length;
}

export async function listSnapshots(projectRoot: string): Promise<SnapshotInfo[]> {
  const files = projectFiles(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(files.snapshotsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const yamls = entries.filter((n) => n.endsWith('.yaml')).sort().reverse();
  const out: SnapshotInfo[] = [];
  for (const name of yamls) {
    const id = name.replace(/\.yaml$/, '');
    const iso = filenameToIso(name);
    if (!iso) continue;
    const st = await stat(join(files.snapshotsDir, name)).catch(() => null);
    if (!st) continue;
    out.push({ id, takenAt: iso, sizeBytes: st.size });
  }
  return out;
}

/**
 * Restore a snapshot to the live storyboard.yaml. Itself reversible — we
 * snapshot the pre-restore state first, so an unintended restore can be
 * undone via another restore call. Throws if the snapshot file is missing.
 */
export async function restoreSnapshot(projectRoot: string, snapshotId: string): Promise<void> {
  const files = projectFiles(projectRoot);
  const source = join(files.snapshotsDir, `${snapshotId}.yaml`);
  // Verify the snapshot exists up-front so we can return a clear error
  // before we touch the live file.
  const exists = await stat(source).then(() => true).catch(() => false);
  if (!exists) throw new Error(`Snapshot not found: ${snapshotId}`);

  // Snapshot the *current* state before overwriting, so the restore can
  // itself be undone.
  await writeSnapshotFromCurrent(projectRoot);

  // Use copyFile (not rename) so the snapshot itself remains on disk.
  await copyFile(source, files.storyboard);
  await pruneSnapshots(projectRoot);
}
