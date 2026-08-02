import { describe, it, expect } from 'vitest';
import type { VideoUnderstandingBrief } from '@vpa/shared';
import { analyzeRecording, proposeSceneMetadataFromBrief, type AnalysisInput } from './index.js';
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

  it('deterministically proposes bounded scene metadata from a video brief', () => {
    const brief: VideoUnderstandingBrief = {
      schema_version: 1,
      prompt_version: 1,
      scene_id: 'scene-01',
      source: {
        path: '/private/project/recordings/scene-01.mp4',
        sha256: 'a'.repeat(64),
        duration_sec: 30,
        width: 1920,
        height: 1080,
      },
      model: { entry_id: 'gemini-video', provider: 'gemini', model: 'gemini-2.5-pro' },
      created_at: '2026-08-01T12:00:00.000Z',
      visual_summary: 'A browser opens the Tanzu dashboard and filters deployment health. The results update immediately.',
      segments: [{
        id: 'segment-1',
        start_sec: 0,
        end_sec: 30,
        screen_change: 'The web app dashboard opens.',
        visible_labels: ['Deployment health'],
        on_screen_terms: ['Browser'],
      }],
      pacing_cues: [],
      narration_cues: [],
      lower_third_candidates: [],
    };

    const scene = { id: 'scene-01', name: 'Old name', description: 'Old description', type: 'desktop' as const };
    const first = proposeSceneMetadataFromBrief(scene, brief);
    const second = proposeSceneMetadataFromBrief(scene, brief);

    expect(first).toEqual(second);
    expect(first).toEqual({
      name: 'A browser opens the Tanzu dashboard',
      description: brief.visual_summary,
      type: 'browser',
    });
  });
});
