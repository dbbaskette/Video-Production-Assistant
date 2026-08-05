import { describe, expect, it } from 'vitest';
import {
  PresentationDraftSchema,
  PresentationJobSchema,
  PresentationManifestSchema,
  PresentationSlideBriefSchema,
  PresentationSourceSchema,
} from './presentation.js';

const presentationId = '1e570aa5-20ce-4779-ad9a-d4db3ae73991';
const projectId = '550e8400-e29b-41d4-a716-446655440000';

const source = {
  presentation_id: presentationId,
  page_number: 2,
  page_count: 3,
  image: `presentations/${presentationId}/pages/page-0002.png`,
  hold_duration_sec: 5,
};

describe('presentation contracts', () => {
  it('accepts bounded presentation source provenance', () => {
    expect(PresentationSourceSchema.parse(source)).toEqual(source);
  });

  it('rejects source provenance that escapes page bounds or its project directory', () => {
    expect(PresentationSourceSchema.safeParse({ ...source, page_number: 4 }).success).toBe(false);
    expect(PresentationSourceSchema.safeParse({ ...source, image: '../secret.png' }).success).toBe(false);
    expect(PresentationSourceSchema.safeParse({ ...source, image: 'C:\\secret.png' }).success).toBe(false);
    expect(PresentationSourceSchema.safeParse({ ...source, hold_duration_sec: 0 }).success).toBe(false);
  });

  it('validates the exact persisted job enums and bounded public errors', () => {
    const job = {
      schema_version: 1,
      id: presentationId,
      project_id: projectId,
      filename: 'Architecture.pdf',
      status: 'processing',
      stage: 'processing-slides',
      generate_narration: true,
      page_count: 3,
      processed_pages: 2,
      analyzed_pages: 1,
      scripted_pages: 1,
      remaining_scene_count: 3,
      created_at: '2026-08-05T12:00:00.000Z',
      updated_at: '2026-08-05T12:00:01.000Z',
    };

    expect(PresentationJobSchema.parse(job)).toEqual(job);
    expect(PresentationJobSchema.safeParse({ ...job, status: 'queued' }).success).toBe(false);
    expect(PresentationJobSchema.safeParse({ ...job, stage: 'analyzing' }).success).toBe(false);
    expect(PresentationJobSchema.safeParse({ ...job, processed_pages: 4 }).success).toBe(false);
    expect(PresentationJobSchema.safeParse({ ...job, error: { code: 'x'.repeat(121), message: 'Nope' } }).success)
      .toBe(false);
  });

  it('requires ordered manifest pages with contiguous one-based page numbers', () => {
    const manifest = {
      schema_version: 1,
      id: presentationId,
      project_id: projectId,
      display_name: 'Architecture.pdf',
      source_sha256: 'a'.repeat(64),
      size_bytes: 1234,
      page_count: 1,
      created_at: '2026-08-05T12:00:00.000Z',
      updated_at: '2026-08-05T12:00:00.000Z',
      generate_narration: true,
      visual_model: { entry_id: 'gemini-pro', model: 'gemini-2.5-pro' },
      writing_model: { entry_id: 'writer', model: 'writer-v1' },
      pages: [
        {
          page_number: 1,
          scene_id: 'scene-slide-1',
          image: `presentations/${presentationId}/pages/page-0001.png`,
          clip: `presentations/${presentationId}/clips/page-0001.mp4`,
          extracted_text: 'Architecture',
          baseline: { name: 'Architecture', description: 'Architecture', narration_script: null },
          analysis_status: 'not-requested',
          script_status: 'not-requested',
        },
      ],
    };

    expect(PresentationManifestSchema.parse(manifest)).toEqual(manifest);
    expect(PresentationManifestSchema.safeParse({ ...manifest, pages: [] }).success).toBe(false);
    expect(PresentationManifestSchema.safeParse({
      ...manifest,
      pages: [{ ...manifest.pages[0], page_number: 2 }],
    }).success).toBe(false);
  });

  it('validates bounded Gemini briefs and writing drafts with provenance', () => {
    const brief = {
      schema_version: 1,
      presentation_id: presentationId,
      page_number: 1,
      image_sha256: 'b'.repeat(64),
      extracted_text_sha256: 'c'.repeat(64),
      model: { entry_id: 'gemini-pro', model: 'gemini-2.5-pro' },
      prompt_version: 1,
      visual_summary: 'A system architecture diagram.',
      detected_title: 'Architecture',
      key_points: ['Service A sends work to Service B.'],
      visual_elements: ['Two connected service boxes.'],
      quantitative_claims: ['99.9% availability'],
      uncertain_content: [],
    };
    const draft = {
      schema_version: 1,
      presentation_id: presentationId,
      page_number: 1,
      brief_fingerprint: 'd'.repeat(64),
      model: { entry_id: 'writer', model: 'writer-v1' },
      script: 'Service A hands work to Service B.',
      created_at: '2026-08-05T12:00:00.000Z',
      applied: false,
    };

    expect(PresentationSlideBriefSchema.parse(brief)).toEqual(brief);
    expect(PresentationDraftSchema.parse(draft)).toEqual(draft);
    expect(PresentationDraftSchema.safeParse({ ...draft, script: 'x'.repeat(12_001) }).success).toBe(false);
  });
});
