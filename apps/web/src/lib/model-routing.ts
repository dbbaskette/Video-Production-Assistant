import type {
  ModelRoutingResponse,
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

export interface ModelEditDraft {
  name: string;
  model: string;
  endpoint: string;
  apiKey: string;
}

export type SceneWritingOutput = 'scene description' | 'script' | 'lower-third copy';

export interface SceneGroundingPresentation {
  visible: boolean;
  ready: boolean;
  disabledReason?: string;
  remediationHref?: string;
}

export function modelEditDraft(
  entry: Pick<ModelEntry, 'name' | 'model' | 'endpoint'>,
): ModelEditDraft {
  return {
    name: entry.name,
    model: entry.model,
    endpoint: entry.endpoint ?? '',
    apiKey: '',
  };
}

export function routingWithAssignment(
  routing: ModelRoutingResponse,
  role: ModelTaskRole,
  modelId: string | null,
): ModelRoutingResponse {
  const assignments = { ...routing.assignments };
  if (modelId === null) delete assignments[role];
  else assignments[role] = modelId;
  return { ...routing, assignments };
}

export function roleIsPending(
  pendingRoles: ReadonlySet<ModelTaskRole>,
  role: ModelTaskRole,
): boolean {
  return pendingRoles.has(role);
}

/**
 * Apply a full server response without rolling back selections whose writes
 * are still queued. Resolutions for those rows stay at their last visible
 * value until the corresponding serialized mutation completes.
 */
export function mergePendingRouting(
  serverRouting: ModelRoutingResponse,
  visibleRouting: ModelRoutingResponse,
  pendingRoles: ReadonlySet<ModelTaskRole>,
): ModelRoutingResponse {
  const assignments = { ...serverRouting.assignments };
  const resolutions = [...serverRouting.resolved];

  for (const role of pendingRoles) {
    const visibleAssignment = visibleRouting.assignments[role];
    if (visibleAssignment === undefined) delete assignments[role];
    else assignments[role] = visibleAssignment;

    const visibleResolution = visibleRouting.resolved.find((item) => item.role === role);
    const serverIndex = resolutions.findIndex((item) => item.role === role);
    if (visibleResolution && serverIndex >= 0) resolutions[serverIndex] = visibleResolution;
  }

  return { assignments, resolved: resolutions };
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
  return mode === 'project' && resolution.scope === 'global' && !resolution.ready
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
  output: SceneWritingOutput = 'script',
): string {
  if (isReady(video) && isReady(writer)) {
    return `${video.name} watches the recording; ${writer.name} writes the ${output}.`;
  }
  if (isReady(writer)) return `${writer.name} writes the ${output}.`;
  if (isReady(video)) return `${video.name} watches the recording.`;
  return 'Assign models before generating content.';
}

export function boundedMessage(message: string, limit = 240): string {
  if (message.length <= limit) return message;
  return `${message.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function sceneGroundingPresentation(
  hasRecording: boolean,
  video: ModelRoutingResolution | undefined,
  projectId: string,
): SceneGroundingPresentation {
  if (!hasRecording) return { visible: false, ready: false };
  if (isReady(video)) return { visible: true, ready: true };

  const reason = video && 'message' in video
    ? video.message
    : 'The video model is not ready.';
  return {
    visible: true,
    ready: false,
    disabledReason: boundedMessage(reason),
    remediationHref: `/project/${projectId}#project-ai-models-title`,
  };
}

/** Preserve the user's explicit request: a selected-but-blocked action throws
 * instead of quietly submitting `groundInVideo: false`. */
export function groundingRequestValue(
  selected: boolean,
  presentation: SceneGroundingPresentation,
): boolean {
  if (!presentation.visible || !selected) return false;
  if (!presentation.ready) {
    throw new Error(presentation.disabledReason ?? 'The video model is not ready.');
  }
  return true;
}

export function groundedGenerationPhase(
  video: ModelRoutingResolution | undefined,
  writer: ModelRoutingResolution | undefined,
  output: SceneWritingOutput,
): string {
  if (isReady(video) && isReady(writer)) {
    return `${video.name} analyzes the recording → ${writer.name} drafts the ${output}…`;
  }
  return `Analyzing the recording → drafting the ${output}…`;
}

function providerLabel(summary: ModelRoutingResolution | undefined): string {
  if (!isReady(summary)) return 'video model';
  const labels: Partial<Record<ResolvedModelSummary['provider'], string>> = {
    gemini: 'Gemini',
    'claude-code': 'Claude',
    'codex-cli': 'Codex',
    anthropic: 'Anthropic',
    'openai-compat': 'OpenAI-compatible model',
    fake: 'test model',
  };
  return labels[summary.provider] ?? summary.name;
}

export function briefFreshnessMessage(
  freshness: 'generated' | 'reused' | undefined,
  video: ModelRoutingResolution | undefined,
): string | undefined {
  if (!freshness) return undefined;
  const provider = providerLabel(video);
  return freshness === 'reused'
    ? `Reusing the current ${provider} timing brief.`
    : `${provider} analyzed the recording and created a new timing brief.`;
}

export function groundedFailureMessage(output: SceneWritingOutput): string {
  const existing = output === 'lower-third copy' ? 'lower thirds' : output;
  return `The video model is not ready. Your existing ${existing} will not be changed.`;
}
