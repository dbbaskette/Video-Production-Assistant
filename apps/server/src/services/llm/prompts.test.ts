import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrompt } from './prompts.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-prompt-'));
  await mkdir(join(tmp, 'prompts'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('loadPrompt', () => {
  it('reads a prompt file from the prompts directory', async () => {
    await writeFile(join(tmp, 'prompts', 'foo.md'), '# system\nhello', 'utf8');
    const text = await loadPrompt(tmp, 'foo');
    expect(text).toBe('# system\nhello');
  });

  it('throws a clear error when prompt missing', async () => {
    await expect(loadPrompt(tmp, 'missing')).rejects.toThrow(/prompts\/missing\.md/);
  });
});
