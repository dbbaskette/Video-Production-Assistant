import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createFakeLlm } from '../llm/index.js';
import { recommendLowerThirds } from './index.js';

function workspaceRoot(): string {
  return resolve(import.meta.dirname, '../../../../..');
}

describe('recommendLowerThirds', () => {
  it('returns an array of lower-third objects', async () => {
    const llm = createFakeLlm();
    const result = await recommendLowerThirds(
      {
        sceneName: 'Configure MCP',
        sceneDescription: 'Show editing the config file',
        sceneType: 'desktop',
        durationSec: 45,
      },
      llm,
      workspaceRoot(),
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('title');
    expect(result[0]).toHaveProperty('in_sec');
    expect(result[0]).toHaveProperty('out_sec');
    expect(result[0]).toHaveProperty('style');
  });

  it('uses scene name in the recommendation', async () => {
    const llm = createFakeLlm();
    const result = await recommendLowerThirds(
      {
        sceneName: 'Server Setup',
        sceneDescription: 'Installing dependencies',
        sceneType: 'terminal',
      },
      llm,
      workspaceRoot(),
    );

    expect(result[0]!.title).toContain('Server Setup');
  });
});
