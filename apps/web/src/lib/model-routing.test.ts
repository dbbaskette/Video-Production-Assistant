import { describe, expect, it } from 'vitest';
import type { ModelRoutingResolution, ModelRoutingResponse, ResolvedModelSummary } from '@vpa/shared';
import type { ModelEntry } from './api.js';
import {
  assignmentPresentation,
  mergePendingRouting,
  modelEditDraft,
  modelAttribution,
  optionsForRole,
  remediationDestination,
  roleIsPending,
  routingWithAssignment,
} from './model-routing.js';

const models: ModelEntry[] = [
  {
    id: 'gemini-pro',
    name: 'Gemini Pro',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    hasApiKey: true,
    capabilities: { text: true, video: true },
    ready: true,
  },
  {
    id: 'claude',
    name: 'Claude',
    provider: 'claude-code',
    model: 'sonnet',
    hasApiKey: false,
    capabilities: { text: true, video: false },
    ready: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    provider: 'codex-cli',
    model: 'default',
    hasApiKey: false,
    capabilities: { text: true, video: false },
    ready: false,
    readinessMessage: 'Codex CLI is unavailable.',
  },
];

function resolved(
  role: ResolvedModelSummary['role'],
  model: ModelEntry,
  scope: ResolvedModelSummary['scope'] = 'global',
): ResolvedModelSummary {
  return {
    role,
    scope,
    entry_id: model.id,
    provider: model.provider,
    model: model.model,
    name: model.name,
    capabilities: model.capabilities,
    ready: true,
  };
}

describe('model routing view models', () => {
  it('offers Gemini video models only and every text-capable model for writing', () => {
    expect(optionsForRole(models, 'video-understanding').map((model) => model.id))
      .toEqual(['gemini-pro']);
    expect(optionsForRole(models, 'writing').map((model) => model.id))
      .toEqual(['gemini-pro', 'claude', 'codex']);
  });

  it('attributes the video and writing stages to their specialists', () => {
    expect(modelAttribution(resolved('video-understanding', models[0]!), resolved('writing', models[2]!)))
      .toBe('Gemini Pro watches the recording; Codex writes the script.');
  });

  it('describes inherited project assignments explicitly', () => {
    const presentation = assignmentPresentation(resolved('writing', models[1]!), 'project');
    expect(presentation.scopeLabel).toBe('Using global setting');
    expect(presentation.label).toBe('Claude');
  });

  it('keeps missing assignments visible and actionable', () => {
    const missing: ModelRoutingResolution = {
      role: 'writing',
      scope: 'global',
      ready: false,
      code: 'model_assignment_missing',
      message: 'No model is assigned to the writing role. Choose one in global model settings.',
    };
    expect(assignmentPresentation(missing, 'global')).toMatchObject({
      label: 'Not assigned',
      tone: 'attention',
    });
    expect(assignmentPresentation(missing, 'project')).toMatchObject({
      label: 'Global setting needs attention',
      remediationHref: '/settings#model-assignments',
    });
  });

  it('explains incompatible assignments without presenting them as ready', () => {
    const incompatible: ModelRoutingResolution = {
      role: 'video-understanding',
      scope: 'project',
      ready: false,
      code: 'model_capability_mismatch',
      message: 'The assigned model cannot handle video-understanding. Choose a compatible model in project model settings.',
    };
    expect(assignmentPresentation(incompatible, 'project')).toMatchObject({
      label: 'Model is not compatible',
      scopeLabel: 'Project override',
      tone: 'attention',
    });
    expect(remediationDestination(incompatible, 'project')).toBeUndefined();
  });

  it('renders unavailable CLI readiness and routes inherited fixes to global settings', () => {
    const unavailable: ModelRoutingResolution = {
      role: 'writing',
      scope: 'global',
      ready: false,
      code: 'model_unavailable',
      message: 'The assigned model for writing is unavailable. Check its configuration in global model settings.',
    };
    expect(assignmentPresentation(unavailable, 'project')).toMatchObject({
      label: 'Model is unavailable',
      detail: expect.stringContaining('unavailable'),
      remediationHref: '/settings#model-assignments',
    });
    expect(remediationDestination(unavailable, 'project')).toBe('/settings#model-assignments');
    expect(remediationDestination(unavailable, 'global')).toBeUndefined();
  });

  it('preserves a newer queued role selection when an earlier full response arrives', () => {
    const initial: ModelRoutingResponse = {
      assignments: {
        'video-understanding': 'gemini-pro',
        writing: 'claude',
        general: 'claude',
      },
      resolved: [
        resolved('video-understanding', models[0]!),
        resolved('writing', models[1]!),
        resolved('general', models[1]!),
      ],
    };
    const optimistic = routingWithAssignment(
      routingWithAssignment(initial, 'writing', 'codex'),
      'general',
      'gemini-pro',
    );
    const firstResponse = routingWithAssignment(initial, 'writing', 'codex');

    const afterFirstResponse = mergePendingRouting(
      firstResponse,
      optimistic,
      new Set(['general']),
    );
    expect(afterFirstResponse.assignments).toMatchObject({
      writing: 'codex',
      general: 'gemini-pro',
    });

    const secondResponse = routingWithAssignment(firstResponse, 'general', 'gemini-pro');
    expect(mergePendingRouting(secondResponse, afterFirstResponse, new Set()).assignments)
      .toEqual(secondResponse.assignments);
  });

  it('marks only the selected assignment row as pending', () => {
    const pending = new Set(['writing'] as const);
    expect(roleIsPending(pending, 'writing')).toBe(true);
    expect(roleIsPending(pending, 'video-understanding')).toBe(false);
    expect(roleIsPending(pending, 'general')).toBe(false);
  });

  it('rebuilds a canceled model edit from saved values without retaining credentials', () => {
    const draft = modelEditDraft(models[0]!);
    draft.name = 'Canceled name';
    draft.model = 'canceled-model';
    draft.endpoint = 'https://canceled.example';
    draft.apiKey = 'secret-that-must-not-survive';

    expect(modelEditDraft(models[0]!)).toEqual({
      name: 'Gemini Pro',
      model: 'gemini-2.5-pro',
      endpoint: '',
      apiKey: '',
    });
  });
});
