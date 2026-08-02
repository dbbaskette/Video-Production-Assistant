import type {
  ModelRoutingResolution,
  ModelTaskRole,
  ResolvedModelSummary,
} from '@vpa/shared';
import type { ModelEntry } from './api.js';

export const MODEL_ASSIGNMENT_ROWS = [
  ['video-understanding', 'Watch and analyze video', 'Creates visual and timing briefs from recordings.'],
  ['writing', 'Write and refine content', 'Writes scripts, ideas, shot plans, and lower-third copy.'],
  ['general', 'General analysis', 'Reviews quality, source documents, and brand information.'],
] as const satisfies ReadonlyArray<readonly [ModelTaskRole, string, string]>;

export type AssignmentMode = 'global' | 'project';

export interface AssignmentPresentation {
  label: string;
  detail: string;
  scopeLabel: string;
  tone: 'ready' | 'attention';
  remediationHref?: string;
}

export function optionsForRole(models: ModelEntry[], role: ModelTaskRole): ModelEntry[] {
  if (role === 'video-understanding') {
    return models.filter((model) => model.provider === 'gemini' && model.capabilities.video);
  }
  return models.filter((model) => model.capabilities.text);
}

export function resolutionForRole(
  resolutions: ModelRoutingResolution[],
  role: ModelTaskRole,
): ModelRoutingResolution {
  return resolutions.find((resolution) => resolution.role === role) ?? {
    role,
    scope: 'global',
    ready: false,
    code: 'model_assignment_missing',
    message: `No model is assigned to the ${role} role.`,
  };
}

export function remediationDestination(
  resolution: ModelRoutingResolution,
  mode: AssignmentMode,
): string | undefined {
  return mode === 'project' && (!resolution.ready || resolution.scope === 'global')
    ? '/settings#model-assignments'
    : undefined;
}

export function assignmentPresentation(
  resolution: ModelRoutingResolution,
  mode: AssignmentMode,
): AssignmentPresentation {
  const scopeLabel = mode === 'project'
    ? resolution.scope === 'project' ? 'Project override' : 'Global setting'
    : 'Global setting';

  if (!('code' in resolution) && resolution.ready) {
    return {
      label: resolution.name,
      detail: `${resolution.provider} / ${resolution.model}`,
      scopeLabel: mode === 'project' && resolution.scope === 'global'
        ? 'Using global setting'
        : scopeLabel,
      tone: 'ready',
    };
  }

  if (!('code' in resolution)) {
    return {
      label: 'Model is unavailable',
      detail: resolution.readinessMessage ?? 'Check this model configuration, then try again.',
      scopeLabel,
      tone: 'attention',
      remediationHref: remediationDestination(resolution, mode),
    };
  }

  const labelByCode = {
    model_assignment_missing: mode === 'project' && resolution.scope === 'global'
      ? 'Global setting needs attention'
      : 'Not assigned',
    model_assignment_invalid: 'Assigned model is missing',
    model_capability_mismatch: 'Model is not compatible',
    model_unavailable: 'Model is unavailable',
  } as const;

  return {
    label: labelByCode[resolution.code],
    detail: resolution.message,
    scopeLabel,
    tone: 'attention',
    remediationHref: remediationDestination(resolution, mode),
  };
}

function isReady(
  resolution: ModelRoutingResolution | undefined,
): resolution is ResolvedModelSummary {
  return resolution?.ready === true && !('code' in resolution);
}

export function modelAttribution(
  video: ModelRoutingResolution | undefined,
  writer: ModelRoutingResolution | undefined,
): string {
  if (isReady(video) && isReady(writer)) {
    return `${video.name} watches the recording; ${writer.name} writes the script.`;
  }
  if (isReady(writer)) return `${writer.name} writes the script.`;
  if (isReady(video)) return `${video.name} watches the recording.`;
  return 'Assign models before generating content.';
}

export function boundedMessage(message: string, limit = 240): string {
  if (message.length <= limit) return message;
  return `${message.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
