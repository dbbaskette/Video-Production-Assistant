import { describe, expect, it } from 'vitest';
import {
  ModelRoutingResponseSchema,
  ModelRoutingUpdateSchema,
  ModelTaskRoleSchema,
  ProjectModelRoutingSchema,
} from './model-routing.js';
import { ProjectSchema } from './project.js';

const project = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'demo-project',
  path: '/projects/demo-project',
  created: '2026-08-01T12:00:00.000Z',
};

describe('model routing contracts', () => {
  it('defines the three supported API task roles', () => {
    expect(ModelTaskRoleSchema.options).toEqual([
      'video-understanding', 'writing', 'general',
    ]);
  });

  it('accepts a partial assignment update and null clearing values', () => {
    expect(ModelRoutingUpdateSchema.parse({
      assignments: { writing: 'codex-main', general: null },
    })).toEqual({ assignments: { writing: 'codex-main', general: null } });
  });

  it('rejects unknown API assignment roles', () => {
    expect(() => ModelRoutingUpdateSchema.parse({
      assignments: { transcription: 'gemini' },
    })).toThrow();
  });

  it('keeps omitted project roles as inherited assignments', () => {
    expect(ProjectModelRoutingSchema.parse({ writing: 'codex-main' })).toEqual({
      writing: 'codex-main',
    });
  });

  it('defaults an existing project without routing to no overrides', () => {
    expect(ProjectSchema.parse(project).model_routing).toEqual({});
  });

  it('persists project video overrides with snake_case keys only', () => {
    expect(ProjectSchema.parse({
      ...project,
      model_routing: {
        video_understanding: 'gemini-video',
        writing: 'codex-main',
      },
    }).model_routing).toEqual({
      video_understanding: 'gemini-video',
      writing: 'codex-main',
    });

    expect(() => ProjectSchema.parse({
      ...project,
      model_routing: { 'video-understanding': 'gemini-video' },
    })).toThrow();
  });

  it('requires exactly one resolved model or bounded error summary per role', () => {
    expect(ModelRoutingResponseSchema.parse({
      assignments: { writing: 'codex-main' },
      resolved: [
        {
          role: 'video-understanding',
          scope: 'global',
          ready: false,
          code: 'model_assignment_missing',
          message: 'Assign a video model in settings.',
        },
        {
          role: 'writing',
          scope: 'global',
          entry_id: 'codex-main',
          provider: 'codex-cli',
          model: 'default',
          name: 'Codex',
          capabilities: { text: true, video: false },
          ready: true,
        },
        {
          role: 'general',
          scope: 'global',
          ready: false,
          code: 'model_assignment_missing',
          message: 'Assign a general model in settings.',
        },
      ],
    })).toMatchObject({ assignments: { writing: 'codex-main' } });
  });
});
