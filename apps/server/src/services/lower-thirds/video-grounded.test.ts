import { describe, expect, it, vi } from 'vitest';
import type { VideoUnderstandingBrief } from '@vpa/shared';
import type { LlmCompleteOptions } from '../llm/index.js';
import { recommendLowerThirdsFromBrief } from './video-grounded.js';

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
      model: 'gemini-2.5-pro',
    },
    created_at: '2026-08-01T12:00:00.000Z',
    visual_summary: 'The dashboard opens before a project is created.',
    segments: [
      {
        id: 'segment-001',
        start_sec: 0,
        end_sec: 8,
        screen_change: 'The dashboard opens.',
        visible_labels: ['Projects'],
        on_screen_terms: ['Workspace'],
      },
      {
        id: 'segment-002',
        start_sec: 8,
        end_sec: 18,
        screen_change: 'The create-project form appears.',
        visible_labels: ['Create project'],
        on_screen_terms: ['Model routing'],
      },
      {
        id: 'segment-003',
        start_sec: 18,
        end_sec: 30,
        screen_change: 'The saved project opens.',
        visible_labels: ['AI models'],
        on_screen_terms: ['Writing'],
      },
    ],
    pacing_cues: [],
    narration_cues: [],
    lower_third_candidates: [
      { segment_id: 'segment-002', reason: 'Introduce role-based model selection.' },
    ],
    ...overrides,
  };
}

function writerResponse(value: unknown) {
  const complete = vi.fn(async (_input: LlmCompleteOptions) => ({ text: JSON.stringify(value) }));
  return { writer: { complete }, complete };
}

function input(inputBrief = brief()) {
  return {
    videoPath: inputBrief.source.path,
    sceneName: 'Model routing',
    sceneDescription: 'Assign a specialist model to each production task.',
    sceneIntent: 'Show that video analysis and writing use separate models.',
    durationSec: inputBrief.source.duration_sec,
    projectObjective: 'Explain task-based model routing.',
    projectAudience: 'Video producers',
    brief: inputBrief,
  };
}

describe('recommendLowerThirdsFromBrief', () => {
  it('maps ordered segment ids to server-owned brief times', async () => {
    const { writer } = writerResponse([
      {
        segment_id: 'segment-001',
        title: 'Project workspace',
        style: 'minimal',
      },
      {
        segment_id: 'segment-003',
        title: 'AI model roles',
        subtitle: 'One specialist per task',
        style: 'frosted',
      },
    ]);

    await expect(recommendLowerThirdsFromBrief(input(), writer, workspaceRoot())).resolves.toEqual([
      {
        title: 'Project workspace',
        style: 'minimal',
        in_sec: 0,
        out_sec: 6,
      },
      {
        title: 'AI model roles',
        subtitle: 'One specialist per task',
        style: 'frosted',
        in_sec: 18,
        out_sec: 24,
      },
    ]);
  });

  it('passes a text-only brief to the writer without local paths or file uris', async () => {
    const videoPath = '/private/project/recordings/scene-01.mp4';
    const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/private-video';
    const inputBrief = brief({
      visual_summary: `The dashboard loads. ${videoPath} ${fileUri}`,
    });
    const { writer, complete } = writerResponse([
      { segment_id: 'segment-002', title: 'Model routing', style: 'frosted' },
    ]);

    await recommendLowerThirdsFromBrief({
      ...input(inputBrief),
      sceneDescription: `Open the recording at ${videoPath} or ${fileUri}.`,
    }, writer, workspaceRoot());

    const request = complete.mock.calls[0]![0];
    expect(request.responseFormat).toBe('json');
    expect(request.userPrompt).toContain('segment-002');
    expect(request.userPrompt).toContain('Return only segment IDs');
    expect(request.userPrompt).not.toContain(videoPath);
    expect(request.userPrompt).not.toContain(fileUri);
    expect(request.userPrompt).not.toContain('gemini-2.5-pro');
    expect(request.userPrompt).not.toContain('gemini-video');
    expect(request.userPrompt).not.toContain('a'.repeat(64));
  });

  it('rejects unknown segment ids', async () => {
    const { writer } = writerResponse([
      { segment_id: 'segment-999', title: 'Invented moment', style: 'solid' },
    ]);

    await expect(recommendLowerThirdsFromBrief(input(), writer, workspaceRoot()))
      .rejects.toThrow('unknown segment');
  });

  it('rejects duplicate segment ids', async () => {
    const { writer } = writerResponse([
      { segment_id: 'segment-002', title: 'Model routing', style: 'frosted' },
      { segment_id: 'segment-002', title: 'Duplicate', style: 'minimal' },
    ]);

    await expect(recommendLowerThirdsFromBrief(input(), writer, workspaceRoot()))
      .rejects.toThrow('duplicate segment');
  });

  it('rejects out-of-order segment selections', async () => {
    const { writer } = writerResponse([
      { segment_id: 'segment-003', title: 'AI models', style: 'frosted' },
      { segment_id: 'segment-001', title: 'Workspace', style: 'minimal' },
    ]);

    await expect(recommendLowerThirdsFromBrief(input(), writer, workspaceRoot()))
      .rejects.toThrow('brief order');
  });

  it('rejects more than five lower thirds', async () => {
    const sixSegments = Array.from({ length: 6 }, (_, index) => ({
      id: `segment-${String(index + 1).padStart(3, '0')}`,
      start_sec: index * 5,
      end_sec: (index + 1) * 5,
      screen_change: `Screen ${index + 1}`,
      visible_labels: [],
      on_screen_terms: [],
    }));
    const inputBrief = brief({ segments: sixSegments });
    const { writer } = writerResponse(sixSegments.map((segment) => ({
      segment_id: segment.id,
      title: segment.screen_change,
      style: 'minimal',
    })));

    await expect(recommendLowerThirdsFromBrief(input(inputBrief), writer, workspaceRoot()))
      .rejects.toThrow();
  });

  it('rejects invalid styles and model-provided raw times', async () => {
    const invalidStyle = writerResponse([
      { segment_id: 'segment-001', title: 'Workspace', style: 'neon' },
    ]);
    await expect(recommendLowerThirdsFromBrief(input(), invalidStyle.writer, workspaceRoot()))
      .rejects.toThrow();

    const rawTimes = writerResponse([
      {
        segment_id: 'segment-001',
        title: 'Workspace',
        style: 'minimal',
        in_sec: 27,
        out_sec: 30,
      },
    ]);
    await expect(recommendLowerThirdsFromBrief(input(), rawTimes.writer, workspaceRoot()))
      .rejects.toThrow();
  });
});
