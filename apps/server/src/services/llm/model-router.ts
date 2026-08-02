import {
  ModelTaskRoleSchema,
  type ModelCapabilities,
  type ModelRoutingErrorCode,
  type ModelRoutingResolution,
  type ModelTaskRole,
  type Project,
  type ResolvedModelSummary,
} from '@vpa/shared';
import type { LlmClient } from './index.js';
import { capabilitiesForProvider, configuredReadiness } from './factory.js';
import type { ModelEntry, ModelProvider, ModelRegistry } from './model-registry.js';
import { RetryingLlm } from './retrying.js';

export const projectFieldByRole = {
  'video-understanding': 'video_understanding',
  writing: 'writing',
  general: 'general',
} as const;

type RoutingScope = 'project' | 'global';
type CliProvider = Extract<ModelProvider, 'claude-code' | 'codex-cli'>;

export interface CliReadiness {
  ready: boolean;
  message?: string;
}

export type CliReadinessProbe = (provider: CliProvider) => Promise<CliReadiness>;
export type ModelRouterWarning = (fields: Record<string, unknown>, message: string) => void;

export interface ModelRouterOptions {
  registry: ModelRegistry;
  createClient: (entry: ModelEntry) => LlmClient;
  checkCliReady: CliReadinessProbe;
  warn?: ModelRouterWarning;
}

export interface ResolvedTextModel {
  client: LlmClient;
  summary: ResolvedModelSummary;
}

export interface ResolvedVideoModel {
  apiKey: string;
  model: string;
  summary: ResolvedModelSummary & { provider: 'gemini' };
}

export class ModelRoutingError extends Error {
  constructor(
    readonly code: ModelRoutingErrorCode,
    readonly role: ModelTaskRole,
    readonly scope: RoutingScope,
    message: string,
    readonly statusCode: 422 | 503,
  ) {
    super(message);
    this.name = 'ModelRoutingError';
  }
}

function publicMessage(
  code: ModelRoutingErrorCode,
  role: ModelTaskRole,
  scope: RoutingScope,
): string {
  const settings = scope === 'project' ? 'project model settings' : 'global model settings';
  switch (code) {
    case 'model_assignment_missing':
      return `No model is assigned to the ${role} role. Choose one in ${settings}.`;
    case 'model_assignment_invalid':
      return `The ${role} assignment references a model that no longer exists. Choose another in ${settings}.`;
    case 'model_capability_mismatch':
      return `The assigned model cannot handle ${role}. Choose a compatible model in ${settings}.`;
    case 'model_unavailable':
      return `The assigned model for ${role} is unavailable. Check its configuration in ${settings}.`;
  }
}

function routingError(
  code: ModelRoutingErrorCode,
  role: ModelTaskRole,
  scope: RoutingScope,
): ModelRoutingError {
  const statusCode = code === 'model_unavailable' ? 503 : 422;
  return new ModelRoutingError(code, role, scope, publicMessage(code, role, scope), statusCode);
}

function summaryFor(
  role: ModelTaskRole,
  scope: RoutingScope,
  entry: ModelEntry,
  capabilities: ModelCapabilities,
): ResolvedModelSummary {
  return {
    role,
    scope,
    entry_id: entry.id,
    provider: entry.provider,
    model: entry.model,
    name: entry.name,
    capabilities,
    ready: true,
  };
}

function isCliProvider(provider: ModelProvider): provider is CliProvider {
  return provider === 'claude-code' || provider === 'codex-cli';
}

export class ModelRouter {
  private readonly registry: ModelRegistry;
  private readonly createClient: (entry: ModelEntry) => LlmClient;
  private readonly checkCliReady: CliReadinessProbe;
  private readonly warn?: ModelRouterWarning;

  constructor(options: ModelRouterOptions) {
    this.registry = options.registry;
    this.createClient = options.createClient;
    this.checkCliReady = options.checkCliReady;
    this.warn = options.warn;
  }

  private selectedId(role: ModelTaskRole, project?: Project): { id?: string; scope: RoutingScope } {
    const override = project?.model_routing[projectFieldByRole[role]];
    return override
      ? { id: override, scope: 'project' }
      : { id: this.registry.getAssignment(role), scope: 'global' };
  }

  private selectedEntry(
    role: ModelTaskRole,
    project?: Project,
  ): { entry: ModelEntry; scope: RoutingScope } {
    const selected = this.selectedId(role, project);
    if (!selected.id) throw routingError('model_assignment_missing', role, selected.scope);
    const entry = this.registry.getById(selected.id);
    if (!entry) throw routingError('model_assignment_invalid', role, selected.scope);
    return { entry, scope: selected.scope };
  }

  private async requireReady(
    role: ModelTaskRole,
    scope: RoutingScope,
    entry: ModelEntry,
  ): Promise<void> {
    const configured = configuredReadiness(entry);
    if (!configured.ready) throw routingError('model_unavailable', role, scope);
    if (!isCliProvider(entry.provider)) return;

    let readiness: CliReadiness;
    try {
      readiness = await this.checkCliReady(entry.provider);
    } catch (error) {
      this.warn?.(
        { error, role, scope, entryId: entry.id, provider: entry.provider },
        'Model CLI readiness probe failed',
      );
      throw routingError('model_unavailable', role, scope);
    }
    if (!readiness.ready) {
      this.warn?.(
        { diagnostic: readiness.message, role, scope, entryId: entry.id, provider: entry.provider },
        'Assigned model CLI is unavailable',
      );
      throw routingError('model_unavailable', role, scope);
    }
  }

  async resolveText(role: 'writing' | 'general', project?: Project): Promise<ResolvedTextModel> {
    const { entry, scope } = this.selectedEntry(role, project);
    const capabilities = capabilitiesForProvider(entry.provider);
    if (!capabilities.text) throw routingError('model_capability_mismatch', role, scope);
    await this.requireReady(role, scope, entry);

    let client: LlmClient;
    try {
      client = this.createClient(entry);
    } catch (error) {
      this.warn?.(
        { error, role, scope, entryId: entry.id, provider: entry.provider, model: entry.model },
        'Assigned model client construction failed',
      );
      throw routingError('model_unavailable', role, scope);
    }

    return {
      client: new RetryingLlm(client),
      summary: summaryFor(role, scope, entry, capabilities),
    };
  }

  async resolveVideo(project?: Project): Promise<ResolvedVideoModel> {
    const role = 'video-understanding' as const;
    const { entry, scope } = this.selectedEntry(role, project);
    const capabilities = capabilitiesForProvider(entry.provider);
    if (entry.provider !== 'gemini' || !capabilities.video) {
      throw routingError('model_capability_mismatch', role, scope);
    }
    await this.requireReady(role, scope, entry);
    if (!entry.apiKey) throw routingError('model_unavailable', role, scope);

    return {
      apiKey: entry.apiKey,
      model: entry.model,
      summary: {
        ...summaryFor(role, scope, entry, capabilities),
        provider: 'gemini',
      },
    };
  }

  async describe(role: ModelTaskRole, project?: Project): Promise<ModelRoutingResolution> {
    try {
      const resolved = role === 'video-understanding'
        ? await this.resolveVideo(project)
        : await this.resolveText(role, project);
      return resolved.summary;
    } catch (error) {
      if (!(error instanceof ModelRoutingError)) throw error;
      return {
        role: error.role,
        scope: error.scope,
        ready: false,
        code: error.code,
        message: error.message,
      };
    }
  }

  async describeAll(project?: Project): Promise<ModelRoutingResolution[]> {
    return Promise.all(ModelTaskRoleSchema.options.map((role) => this.describe(role, project)));
  }
}
