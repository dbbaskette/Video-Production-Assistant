import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { isSafeProjectRelativePath } from '@vpa/shared';

export class UnsafeProjectPathError extends Error {
  readonly code = 'unsafe_project_path';
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolve a project-owned relative path and reject traversal and symlink
 * components. The final component may be absent for a new write.
 */
export async function resolveSafeProjectPath(projectRoot: string, relativePath: string): Promise<string> {
  if (!isSafeProjectRelativePath(relativePath)) {
    throw new UnsafeProjectPathError('Project path is invalid.');
  }

  const rootInfo = await lstat(projectRoot);
  if (rootInfo.isSymbolicLink()) throw new UnsafeProjectPathError('Symbolic-link project roots are not allowed.');
  const canonicalRoot = await realpath(projectRoot);
  const candidate = path.resolve(canonicalRoot, relativePath);
  if (!contained(canonicalRoot, candidate)) {
    throw new UnsafeProjectPathError('Project path escapes its project.');
  }

  const segments = relativePath.split('/');
  let current = canonicalRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new UnsafeProjectPathError('Symbolic links are not allowed in project-owned paths.');
      const resolved = await realpath(current);
      if (!contained(canonicalRoot, resolved) && resolved !== canonicalRoot) {
        throw new UnsafeProjectPathError('Project path escapes its project.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return candidate;
}
