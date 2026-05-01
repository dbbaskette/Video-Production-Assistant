import { describe, it, expect } from 'vitest';
import { analyzeRecording, type AnalysisInput } from './index.js';
import { createFakeLlm } from '../llm/index.js';
import path from 'node:path';

// Workspace root is the repo root (3 levels up from this test file)
function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../../..');
}

describe('video analysis', () => {
  it('analyzes a recording and returns scene info', async () => {
    const llm = createFakeLlm();
    const input: AnalysisInput = {
      filename: 'scene-01.mp4',
      duration_sec: 47.2,
      width: 1920,
      height: 1080,
      sceneIndex: 0,
      totalScenes: 3,
      projectObjective: 'Demo MCP server setup',
    };

    const result = await analyzeRecording(input, llm, workspaceRoot());
    expect(result.name).toBeTruthy();
    expect(result.description).toBeTruthy();
    expect(['desktop', 'terminal', 'browser', 'slide']).toContain(result.type);
  });

  it('works without project objective', async () => {
    const llm = createFakeLlm();
    const input: AnalysisInput = {
      filename: 'clip.mp4',
      duration_sec: 30,
      width: 1280,
      height: 720,
      sceneIndex: 0,
      totalScenes: 1,
    };

    const result = await analyzeRecording(input, llm, workspaceRoot());
    expect(result.name).toBeTruthy();
    expect(result.description).toBeTruthy();
  });
});
