import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
