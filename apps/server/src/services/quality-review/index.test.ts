import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakeLlm } from '../llm/index.js';
import { runQualityReview } from './index.js';
import type { Storyboard } from '@vpa/shared';
import type { LlmClient } from '../llm/index.js';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../../..');
}

function makeSampleStoryboard(): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: randomUUID(),
      name: 'test-proj',
      created: new Date().toISOString(),
      objective: 'Demo quality review',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Introduction', type: 'desktop' },
      { id: 'scene-02', name: 'Setup', description: 'Setting up', type: 'terminal' },
    ],
  };
}

describe('quality review service', () => {
  it('returns review items with summary', async () => {
    const llm = createFakeLlm();
    const sb = makeSampleStoryboard();
    const result = await runQualityReview(sb, llm, workspaceRoot());

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.summary.total).toBe(result.items.length);
    expect(result.summary.info + result.summary.warn + result.summary.issue).toBe(result.summary.total);
    expect(['ok', 'warnings', 'issues']).toContain(result.status);
    expect(result.reviewedAt).toBeTruthy();
  });

  it('items have required fields', async () => {
    const llm = createFakeLlm();
    const sb = makeSampleStoryboard();
    const result = await runQualityReview(sb, llm, workspaceRoot());

    for (const item of result.items) {
      expect(item.sceneId).toBeTruthy();
      expect(['info', 'warn', 'issue']).toContain(item.severity);
      expect(item.category).toBeTruthy();
      expect(item.message).toBeTruthy();
    }
  });

  it('status reflects worst severity', async () => {
    const llm = createFakeLlm();
    const sb = makeSampleStoryboard();
    const result = await runQualityReview(sb, llm, workspaceRoot());

    // Fake LLM returns warn items, so status should be 'warnings'
    expect(result.status).toBe('warnings');
  });

  it('suppresses narration length warnings for flexible presentation scenes', async () => {
    let userPrompt = '';
    let systemPrompt = '';
    const llm: LlmClient = {
      async complete(opts) {
        userPrompt = opts.userPrompt;
        systemPrompt = opts.systemPrompt;
        return { text: '[]' };
      },
    };
    const sb = makeSampleStoryboard();
    sb.scenes = [{
      id: 'scene-slide',
      name: 'Slide',
      description: 'A slide',
      type: 'slide',
      recording: {
        source: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/clips/page-0001.mp4',
        source_kind: 'presentation',
        duration_sec: 1,
      },
      presentation_source: {
        presentation_id: '1e570aa5-20ce-4779-ad9a-d4db3ae73991',
        page_number: 1,
        page_count: 1,
        image: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/pages/page-0001.png',
        hold_duration_sec: 5,
      },
      narration: {
        script: Array.from({ length: 100 }, () => 'word').join(' '),
        audio: 'narration/slide.mp3',
        chunks: [{ index: 0, text: 'word', audio: 'narration/chunk.mp3', durationSec: 8.25 }],
      },
    }];

    await runQualityReview(sb, llm, workspaceRoot());

    expect(userPrompt).toContain('Narration sets final length');
    expect(userPrompt).toContain('skip narration length check');
    expect(userPrompt).not.toContain('TOO LONG');
    expect(userPrompt).not.toContain('vs 1s recording');
    expect(systemPrompt).toContain('narration_too_long');
  });

  it('filters exact presentation narration_too_long categories without classifying message prose', async () => {
    const llm: LlmClient = {
      async complete() {
        return { text: JSON.stringify([
          {
            sceneId: 'scene-slide',
            severity: 'warn',
            category: 'narration_too_long',
            message: 'Review the narration timing.',
          },
          {
            sceneId: 'scene-slide',
            severity: 'warn',
            category: 'narration',
            message: 'Narration volume is over target and may clip.',
          },
          {
            sceneId: 'scene-video',
            severity: 'warn',
            category: 'narration_too_long',
            message: 'Narration exceeds the recording duration.',
          },
          {
            sceneId: 'scene-slide',
            severity: 'info',
            category: 'description',
            message: 'The scene description is clear.',
          },
        ]) };
      },
    };
    const sb = makeSampleStoryboard();
    sb.scenes = [
      {
        id: 'scene-slide',
        name: 'Slide',
        description: 'A slide',
        type: 'slide',
        recording: {
          source: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/clips/page-0001.mp4',
          source_kind: 'presentation',
          duration_sec: 1,
        },
        presentation_source: {
          presentation_id: '1e570aa5-20ce-4779-ad9a-d4db3ae73991',
          page_number: 1,
          page_count: 1,
          image: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/pages/page-0001.png',
          hold_duration_sec: 5,
        },
      },
      {
        id: 'scene-video',
        name: 'Video',
        description: 'A recording',
        type: 'desktop',
        recording: { source: 'recordings/video.mp4', duration_sec: 30 },
      },
    ];

    const result = await runQualityReview(sb, llm, workspaceRoot());

    expect(result.items).toEqual([
      expect.objectContaining({
        sceneId: 'scene-slide',
        category: 'narration',
        message: 'Narration volume is over target and may clip.',
      }),
      expect.objectContaining({ sceneId: 'scene-video', category: 'narration_too_long' }),
      expect.objectContaining({ sceneId: 'scene-slide', category: 'description' }),
    ]);
    expect(result.summary).toEqual({ total: 3, info: 1, warn: 2, issue: 0 });
  });

  it('strictly rejects unknown categories, extra fields, and bounded-output violations', async () => {
    const sb = makeSampleStoryboard();
    const invalidPayloads = [
      [{ sceneId: 'scene-01', severity: 'warn', category: 'narration_length', message: 'Too long.' }],
      [{ sceneId: 'scene-01', severity: 'warn', category: 'narration', message: 'Missing.', raw: 'secret' }],
      [{ sceneId: 'scene-01', severity: 'warn', category: 'narration', message: 'x'.repeat(2_001) }],
      Array.from({ length: 501 }, () => ({
        sceneId: 'scene-01',
        severity: 'info',
        category: 'general',
        message: 'Bounded item.',
      })),
    ];

    for (const payload of invalidPayloads) {
      const llm: LlmClient = {
        async complete() {
          return { text: JSON.stringify(payload) };
        },
      };
      await expect(runQualityReview(sb, llm, workspaceRoot())).rejects.toThrow();
    }
  });
});
