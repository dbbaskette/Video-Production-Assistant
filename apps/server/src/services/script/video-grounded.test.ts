import { describe, expect, it, vi } from 'vitest';
import type { VideoUnderstandingBrief } from '@vpa/shared';
import type { LlmClient, LlmCompleteOptions } from '../llm/index.js';
import { REFERENCE_BUDGET_CHARS } from '../project-source-docs/context.js';
import {
  generateScriptFromVideoBrief,
  serializeVideoUnderstandingBrief,
} from './video-grounded.js';

function workspaceRoot(): string {
  return new URL('../../../../..', import.meta.url).pathname;
}

function brief(overrides: Partial<VideoUnderstandingBrief> = {}): VideoUnderstandingBrief {
  return {
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
    model: {
      entry_id: 'gemini-video',
      provider: 'gemini',
      model: 'gemini-video-model',
    },
    created_at: '2026-08-01T12:00:00.000Z',
    visual_summary: 'A dashboard opens and the user selects Create project.',
    segments: [
      {
        id: 'segment-001',
        start_sec: 0,
        end_sec: 12.5,
        screen_change: 'The dashboard loads.',
        visible_labels: ['Create project'],
        on_screen_terms: ['Workspace'],
      },
      {
        id: 'segment-002',
        start_sec: 12.5,
        end_sec: 30,
        screen_change: 'The project form is submitted.',
        visible_labels: ['Project name', 'Create'],
        on_screen_terms: ['Demo workspace'],
      },
    ],
    pacing_cues: [{ segment_id: 'segment-001', cue: 'Leave room for the dashboard to settle.' }],
    narration_cues: [{ segment_id: 'segment-002', cue: 'Explain why the project name matters.' }],
    lower_third_candidates: [],
    ...overrides,
  };
}

describe('generateScriptFromVideoBrief', () => {
  it('passes only bounded brief fields to the text writer', async () => {
    const videoPath = '/private/project/recordings/scene-01.mp4';
    const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/private-video';
    const apiKey = 'gemini-secret-key';
    const complete = vi.fn(async (_input: LlmCompleteOptions) => ({
      text: 'A grounded narration script.',
    }));
    const writer = { complete } satisfies LlmClient;
    const inputBrief = brief({
      visual_summary: `The dashboard loads. ${videoPath} ${fileUri}`,
    });

    const script = await generateScriptFromVideoBrief({
      sceneName: 'Create a project',
      sceneDescription: 'Create a project from the dashboard.',
      durationSec: 30,
      sourceContext: 'The product calls projects workspaces.',
      brief: inputBrief,
    }, writer, workspaceRoot());

    expect(script).toBe('A grounded narration script.');
    expect(writer.complete).toHaveBeenCalledTimes(1);
    const prompt = complete.mock.calls[0]![0].userPrompt;
    expect(prompt).toContain('segment-001');
    expect(prompt).toContain('0.000-12.500');
    expect(prompt).toContain('Create project');
    expect(prompt).toContain('visual truth');
    expect(prompt).toContain('factual truth');
    expect(prompt).not.toContain(videoPath);
    expect(prompt).not.toContain(fileUri);
    expect(prompt).not.toContain(apiKey);
    expect(prompt).not.toContain('gemini-video-model');
    expect(prompt).not.toContain('gemini-video');
    expect(prompt).not.toContain('a'.repeat(64));
  });

  it('keeps every segment id and time range inside the prompt budget', () => {
    const segments = Array.from({ length: 200 }, (_, index) => ({
      id: `segment-${String(index + 1).padStart(3, '0')}-${'x'.repeat(80)}`,
      start_sec: index / 10,
      end_sec: (index + 1) / 10,
      screen_change: 'A'.repeat(2_000),
      visible_labels: Array.from({ length: 50 }, () => 'L'.repeat(200)),
      on_screen_terms: Array.from({ length: 50 }, () => 'T'.repeat(200)),
    }));
    const largeBrief = brief({
      source: { ...brief().source, duration_sec: 20 },
      visual_summary: 'V'.repeat(4_000),
      segments,
      pacing_cues: segments.slice(0, 100).map((segment) => ({
        segment_id: segment.id,
        cue: 'P'.repeat(1_000),
      })),
      narration_cues: segments.slice(100).map((segment) => ({
        segment_id: segment.id,
        cue: 'N'.repeat(1_000),
      })),
    });

    const serialized = serializeVideoUnderstandingBrief(largeBrief);

    expect(serialized.length).toBeLessThanOrEqual(REFERENCE_BUDGET_CHARS);
    for (const segment of segments) {
      expect(serialized).toContain(segment.id);
      expect(serialized).toContain(
        `${segment.start_sec.toFixed(3)}-${segment.end_sec.toFixed(3)}`,
      );
    }
    expect(serialized).not.toContain(largeBrief.source.path);
    expect(serialized).not.toContain(largeBrief.source.sha256);
    expect(serialized).not.toContain(largeBrief.model.model);
  });
});
