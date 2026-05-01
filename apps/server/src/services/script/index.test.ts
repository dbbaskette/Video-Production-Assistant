import { describe, it, expect } from 'vitest';
import { generateScript, type ScriptInput } from './index.js';
import { createFakeLlm } from '../llm/index.js';
import path from 'node:path';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../../..');
}

describe('script generation', () => {
  it('generates a narration script with emotive tags', async () => {
    const llm = createFakeLlm();
    const input: ScriptInput = {
      sceneName: 'Configure the MCP Server',
      sceneDescription: 'Show editing claude_desktop_config.json with the new server entry',
      sceneType: 'desktop',
      durationSec: 47.2,
      projectObjective: 'Demo MCP server setup',
    };

    const script = await generateScript(input, llm, workspaceRoot());
    expect(script).toBeTruthy();
    expect(script).toContain('[');  // contains emotive tags
    expect(script.length).toBeGreaterThan(50);
  });

  it('works without optional fields', async () => {
    const llm = createFakeLlm();
    const input: ScriptInput = {
      sceneName: 'Intro',
      sceneDescription: 'Introduction scene',
      sceneType: 'desktop',
    };

    const script = await generateScript(input, llm, workspaceRoot());
    expect(script).toBeTruthy();
  });

  it('includes scene name in the output', async () => {
    const llm = createFakeLlm();
    const input: ScriptInput = {
      sceneName: 'First Run and Verification',
      sceneDescription: 'Run the system and verify output',
      sceneType: 'terminal',
      durationSec: 30,
    };

    const script = await generateScript(input, llm, workspaceRoot());
    expect(script).toContain('First Run and Verification');
  });
});
