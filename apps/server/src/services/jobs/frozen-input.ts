import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { projectFiles } from '../project/paths.js';
import { RevisionStore } from '../revisions/store.js';

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Freeze the authoritative revision plus a hash of the actual input documents/options. */
export async function freezeProjectJobInput(projectRoot: string, options: unknown) {
  const files = projectFiles(projectRoot);
  const [inputRevision, projectYaml, storyboardYaml] = await Promise.all([
    new RevisionStore(projectRoot).currentRevision(),
    optionalText(files.metadata),
    optionalText(files.storyboard),
  ]);
  const inputFingerprint = createHash('sha256')
    .update(projectYaml)
    .update('\0')
    .update(storyboardYaml)
    .update('\0')
    .update(JSON.stringify(options))
    .digest('hex');
  return { inputRevision, inputFingerprint };
}

/**
 * Make a private, immutable-once-submitted project copy for long-running jobs.
 * If the source changes while it is being copied, discard it and retry once so
 * a render can never silently combine two revisions.
 */
export async function snapshotProjectJobInput(projectRoot: string, options: unknown) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await freezeProjectJobInput(projectRoot, options);
    const container = await mkdtemp(join(tmpdir(), 'vpa-render-'));
    const snapshotRoot = join(container, 'project');
    try {
      await cp(projectRoot, snapshotRoot, {
        recursive: true,
        force: false,
        filter: (source) => {
          const rel = relative(projectRoot, source);
          const first = rel.split(/[\\/]/)[0];
          return first !== 'renders' && first !== '.snapshots' && first !== '.presentation-staging';
        },
      });
      const after = await freezeProjectJobInput(projectRoot, options);
      if (before.inputRevision === after.inputRevision && before.inputFingerprint === after.inputFingerprint) {
        return {
          ...before,
          projectPath: snapshotRoot,
          cleanup: () => rm(container, { recursive: true, force: true }),
        };
      }
    } catch (error) {
      await rm(container, { recursive: true, force: true });
      throw error;
    }
    await rm(container, { recursive: true, force: true });
  }
  throw new Error('input_changed: project changed while the render snapshot was being created');
}
