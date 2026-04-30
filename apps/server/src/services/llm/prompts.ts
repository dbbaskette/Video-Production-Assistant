import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadPrompt(workspaceRoot: string, name: string): Promise<string> {
  const path = join(workspaceRoot, 'prompts', `${name}.md`);
  try {
    return await readFile(path, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Prompt not found: prompts/${name}.md`);
    }
    throw err;
  }
}
