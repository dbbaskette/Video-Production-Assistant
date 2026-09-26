import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ProductionRecipeSchema,
  ProjectCommandSchema,
  type ProjectCommandBatch,
} from '@vpa/shared';
import {
  VpaAutomationClient,
  type ProjectNarrationRequest,
  type ProjectRenderRequest,
  type StandaloneNarrationRequest,
} from '@vpa/cli/automation';
import { VpaCliError, VpaHttpClient, type HttpClient } from '@vpa/cli/client';
import { z } from 'zod';

const VERSION = '0.0.1';
const ProjectId = z.string().min(1).max(200).describe('Stable VPA project ID.');
const JobId = z.string().min(1).max(200).describe('VPA job ID returned by an asynchronous operation.');
const IdempotencyKey = z.string().min(8).max(120).describe('Caller-stable key. Reuse only for the exact same logical request.');
const Expressiveness = z.enum(['light', 'medium', 'heavy']);

const ToolOutput = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().optional(),
    details: z.unknown().optional(),
  }).optional(),
});

type ToolOutputValue = z.infer<typeof ToolOutput>;

function success(summary: string, result: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { ok: true, result } satisfies ToolOutputValue,
  };
}

function failure(error: unknown): CallToolResult {
  const known = error instanceof VpaCliError
    ? error
    : new VpaCliError(error instanceof Error ? error.message : String(error), 'unexpected_error');
  const payload = {
    code: known.code,
    message: known.message,
    ...(known.status === undefined ? {} : { status: known.status }),
    ...(known.details === undefined ? {} : { details: known.details }),
  };
  return {
    isError: true,
    content: [{ type: 'text', text: `VPA error [${known.code}]: ${known.message}` }],
    structuredContent: { ok: false, error: payload } satisfies ToolOutputValue,
  };
}

async function call(summary: (value: unknown) => string, operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    return success(summary(result), result);
  } catch (error) {
    return failure(error);
  }
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [{
      uri: uri.toString(),
      mimeType: 'application/json',
      text: JSON.stringify(value, null, 2),
    }],
  };
}

export function createVpaMcpServer(options: {
  httpClient?: HttpClient;
  apiUrl?: string;
} = {}): McpServer {
  const apiUrl = options.apiUrl ?? process.env.VPA_API_URL ?? 'http://127.0.0.1:3000';
  const automation = new VpaAutomationClient(options.httpClient ?? new VpaHttpClient(apiUrl));
  const server = new McpServer(
    { name: 'vpa-production', version: VERSION },
    {
      instructions: 'Use read tools before actions. For project edits, read the current revision and supply a stable idempotency key. Narration and render actions require explicit settings and return VPA-owned artifacts or durable job IDs. Never infer provider credentials.',
    },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const action = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool('list_projects', {
    title: 'List VPA projects',
    description: 'List projects known to the local VPA instance before selecting a project ID.',
    inputSchema: {}, outputSchema: ToolOutput, annotations: readOnly,
  }, () => call(() => 'Listed VPA projects.', () => automation.listProjects()));

  server.registerTool('get_project', {
    title: 'Get a VPA project',
    description: 'Read one VPA project, including its production brief and current project metadata.',
    inputSchema: { projectId: ProjectId }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ projectId }) => call(() => `Loaded project ${projectId}.`, () => automation.getProject(projectId)));

  server.registerTool('get_project_revision', {
    title: 'Get project revision',
    description: 'Read the current and accepted revision before preparing a revision-aware mutation.',
    inputSchema: { projectId: ProjectId }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ projectId }) => call(() => `Loaded the current revision for ${projectId}.`, () => automation.getProjectRevision(projectId)));

  server.registerTool('list_project_revisions', {
    title: 'List project revisions',
    description: 'List recent immutable project revisions and concise change summaries.',
    inputSchema: { projectId: ProjectId }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ projectId }) => call(() => `Listed revisions for ${projectId}.`, () => automation.listProjectRevisions(projectId)));

  server.registerTool('execute_project_commands', {
    title: 'Apply revision-aware project commands',
    description: 'Apply a validated VPA command batch. Read the current revision first and reuse the idempotency key only for an identical retry.',
    inputSchema: {
      projectId: ProjectId,
      expectedRevision: z.number().int().nonnegative(),
      idempotencyKey: IdempotencyKey,
      targetState: z.enum(['draft', 'accepted']).optional(),
      commands: z.array(ProjectCommandSchema).min(1).max(200),
    },
    outputSchema: ToolOutput,
    annotations: action,
  }, ({ projectId, expectedRevision, idempotencyKey, targetState, commands }) => {
    const batch = { expectedRevision, idempotencyKey, targetState, commands } as ProjectCommandBatch;
    return call(() => `Applied ${commands.length} command${commands.length === 1 ? '' : 's'} to ${projectId}.`, () => automation.executeProjectCommands(projectId, batch));
  });

  server.registerTool('list_narration_engines', {
    title: 'List narration engines',
    description: 'List configured narration engines with readiness, voices, speed bounds, expressiveness, tags, timing, subtitle, format, and input capabilities.',
    inputSchema: {}, outputSchema: ToolOutput, annotations: readOnly,
  }, () => call(() => 'Listed configured narration engines.', () => automation.listNarrationEngines()));

  server.registerTool('list_narration_voices', {
    title: 'List narration voices',
    description: 'List stable narration voice IDs, optionally restricted to one configured engine.',
    inputSchema: { engineId: z.string().min(1).max(100).optional() }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ engineId }) => call(() => engineId ? `Listed voices for ${engineId}.` : 'Listed narration voices.', () => automation.listNarrationVoices(engineId)));

  server.registerTool('list_narration_profiles', {
    title: 'List narration profiles',
    description: 'List saved VPA voice profiles and their explicit engine, voice, and speed configuration.',
    inputSchema: {}, outputSchema: ToolOutput, annotations: readOnly,
  }, () => call(() => 'Listed narration profiles.', () => automation.listNarrationProfiles()));

  server.registerTool('describe_narration_engine', {
    title: 'Describe narration engine',
    description: 'Read every advertised capability for one configured narration engine before generating audio.',
    inputSchema: { engineId: z.string().min(1).max(100) }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ engineId }) => call(
    () => `Loaded narration options for ${engineId}.`,
    () => automation.describeNarrationEngine(engineId),
  ));

  server.registerTool('create_standalone_narration', {
    title: 'Create standalone narration',
    description: 'Create a durable standalone audio artifact. Supply either profile, or engine and voice. The call returns only after VPA persists the clip.',
    inputSchema: {
      text: z.string().min(1),
      profile: z.string().min(1).max(200).optional(),
      engine: z.string().min(1).max(100).optional(),
      voice: z.string().min(1).max(200).optional(),
      speed: z.number().finite().optional(),
      expressiveness: Expressiveness.optional(),
      idempotencyKey: IdempotencyKey,
    }, outputSchema: ToolOutput, annotations: action,
  }, ({ idempotencyKey, ...input }) => call(
    () => 'Created and persisted a standalone narration artifact.',
    () => automation.createStandaloneNarration(input as StandaloneNarrationRequest, idempotencyKey),
  ));

  server.registerTool('start_project_narration', {
    title: 'Start project narration',
    description: 'Start project-wide narration as a durable VPA job. Explicit engine, voice, speed, expressiveness, overwrite choice, and idempotency key are required.',
    inputSchema: {
      projectId: ProjectId,
      engine: z.string().min(1).max(100),
      voice: z.string().min(1).max(200),
      speed: z.number().finite(),
      expressiveness: Expressiveness,
      overwrite: z.boolean(),
      idempotencyKey: IdempotencyKey,
    }, outputSchema: ToolOutput, annotations: action,
  }, ({ projectId, idempotencyKey, ...input }) => call(
    (value) => `Project narration submitted as job ${(value as { jobId?: string }).jobId ?? 'unknown'}.`,
    () => automation.startProjectNarration(projectId, input as ProjectNarrationRequest, idempotencyKey),
  ));

  server.registerTool('list_jobs', {
    title: 'List VPA jobs',
    description: 'List durable VPA jobs, optionally restricted to active jobs or one project.',
    inputSchema: { active: z.boolean().optional(), projectId: ProjectId.optional() }, outputSchema: ToolOutput, annotations: readOnly,
  }, (input) => call(() => 'Listed VPA jobs.', () => automation.listJobs(input)));

  server.registerTool('get_job', {
    title: 'Get VPA job',
    description: 'Read durable job status, bounded progress events, terminal failure, and verified artifacts. Treat only completed jobs with expected artifacts as successful.',
    inputSchema: { jobId: JobId }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ jobId }) => call(() => `Loaded job ${jobId}.`, () => automation.getJob(jobId)));

  server.registerTool('list_production_recipes', {
    title: 'List production recipes',
    description: 'List bounded VPA production recipes and their declared effects.',
    inputSchema: {}, outputSchema: ToolOutput, annotations: readOnly,
  }, () => call(() => 'Listed production recipes.', () => automation.listProductionRecipes()));

  server.registerTool('inspect_production_recipe', {
    title: 'Inspect production recipe',
    description: 'Check recipe support, source evidence, blockers, and current revision without changing the project.',
    inputSchema: { projectId: ProjectId, recipe: ProductionRecipeSchema }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ projectId, recipe }) => call(() => `Inspected ${recipe} for ${projectId}.`, () => automation.inspectProductionRecipe(projectId, recipe)));

  server.registerTool('run_production_recipe', {
    title: 'Run production recipe',
    description: 'Apply a bounded VPA production recipe and start its durable render job.',
    inputSchema: { projectId: ProjectId, recipe: ProductionRecipeSchema, idempotencyKey: IdempotencyKey }, outputSchema: ToolOutput, annotations: action,
  }, ({ projectId, recipe, idempotencyKey }) => call(
    (value) => `Production recipe submitted as job ${(value as { jobId?: string }).jobId ?? 'unknown'}.`,
    () => automation.runProductionRecipe(projectId, recipe, idempotencyKey),
  ));

  server.registerTool('start_project_render', {
    title: 'Start project render',
    description: 'Start a revision-frozen project render as a durable VPA job. Reuse the idempotency key only for an identical retry.',
    inputSchema: {
      projectId: ProjectId,
      idempotencyKey: IdempotencyKey,
      audioMode: z.enum(['replace', 'mix']).optional(),
      burnSubtitles: z.boolean().optional(),
      includeNarration: z.boolean().optional(),
      includeLowerThirds: z.boolean().optional(),
      musicTrackId: z.string().nullable().optional(),
      musicVolumeDb: z.number().finite().optional(),
      musicScope: z.enum(['full', 'bumpers']).optional(),
      useBrandBumpers: z.boolean().optional(),
      useBrandMusic: z.boolean().optional(),
      quality: z.enum(['draft', '1080p']).optional(),
    }, outputSchema: ToolOutput, annotations: action,
  }, ({ projectId, idempotencyKey, ...input }) => call(
    (value) => `Project render submitted as job ${(value as { jobId?: string }).jobId ?? 'unknown'}.`,
    () => automation.startProjectRender(projectId, input as ProjectRenderRequest, idempotencyKey),
  ));

  server.registerTool('get_render_status', {
    title: 'Get project render status',
    description: 'Read the latest render manifest, revision freshness, playable artifact metadata, and prior artifacts for a project.',
    inputSchema: { projectId: ProjectId }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ projectId }) => call(() => `Loaded render status for ${projectId}.`, () => automation.getRenderStatus(projectId)));

  server.registerTool('list_feedback', {
    title: 'List project feedback',
    description: 'List source-anchored feedback notes and their current claim/resolution state.',
    inputSchema: { projectId: ProjectId }, outputSchema: ToolOutput, annotations: readOnly,
  }, ({ projectId }) => call(() => `Listed feedback for ${projectId}.`, () => automation.listFeedback(projectId)));

  server.registerTool('claim_feedback', {
    title: 'Claim feedback note',
    description: 'Claim one pending feedback note for an explicit actor before editing.',
    inputSchema: {
      projectId: ProjectId,
      noteId: z.string().min(1).max(200),
      actor: z.string().min(1).max(200),
      claimedAt: z.string().datetime(),
      expectedRevision: z.number().int().nonnegative(),
      idempotencyKey: IdempotencyKey,
    }, outputSchema: ToolOutput, annotations: action,
  }, ({ projectId, noteId, actor, claimedAt, expectedRevision, idempotencyKey }) => call(
    () => `Claimed feedback ${noteId}.`,
    () => automation.executeProjectCommands(projectId, {
      expectedRevision, idempotencyKey, targetState: 'accepted',
      commands: [{ type: 'feedback.claim', noteId, actor, claimedAt }],
    }),
  ));

  server.registerTool('resolve_feedback', {
    title: 'Resolve feedback note',
    description: 'Resolve a claimed feedback note by naming the produced project revision and resolution.',
    inputSchema: {
      projectId: ProjectId,
      noteId: z.string().min(1).max(200),
      resolvingRevision: z.number().int().nonnegative(),
      resolution: z.string().min(1).max(4_000),
      expectedRevision: z.number().int().nonnegative(),
      idempotencyKey: IdempotencyKey,
    }, outputSchema: ToolOutput, annotations: action,
  }, ({ projectId, noteId, resolvingRevision, resolution, expectedRevision, idempotencyKey }) => call(
    () => `Resolved feedback ${noteId}.`,
    () => automation.executeProjectCommands(projectId, {
      expectedRevision, idempotencyKey, targetState: 'accepted',
      commands: [{ type: 'feedback.resolve', noteId, resolvingRevision, resolution }],
    }),
  ));

  server.registerTool('fail_feedback', {
    title: 'Mark feedback attempt failed',
    description: 'Record a bounded failure for a feedback note without falsely resolving it.',
    inputSchema: {
      projectId: ProjectId,
      noteId: z.string().min(1).max(200),
      failure: z.string().min(1).max(1_000),
      expectedRevision: z.number().int().nonnegative(),
      idempotencyKey: IdempotencyKey,
    }, outputSchema: ToolOutput, annotations: action,
  }, ({ projectId, noteId, failure: message, expectedRevision, idempotencyKey }) => call(
    () => `Recorded a failed attempt for feedback ${noteId}.`,
    () => automation.executeProjectCommands(projectId, {
      expectedRevision, idempotencyKey, targetState: 'accepted',
      commands: [{ type: 'feedback.fail', noteId, failure: message }],
    }),
  ));

  server.registerResource('vpa-projects', 'vpa://projects', {
    title: 'VPA projects', description: 'Live project catalog from the local VPA instance.', mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, await automation.listProjects()));
  server.registerResource('vpa-narration-engines', 'vpa://narration/engines', {
    title: 'VPA narration engines', description: 'Live configured narration capability catalog.', mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, await automation.listNarrationEngines()));
  server.registerResource('vpa-narration-profiles', 'vpa://narration/profiles', {
    title: 'VPA narration profiles', description: 'Live saved narration profiles.', mimeType: 'application/json',
  }, async (uri) => jsonResource(uri, await automation.listNarrationProfiles()));

  const templates: Array<{
    name: string;
    pattern: string;
    title: string;
    read: (variables: Record<string, string | string[]>) => Promise<unknown>;
  }> = [
    { name: 'vpa-project', pattern: 'vpa://projects/{projectId}', title: 'VPA project', read: ({ projectId }) => automation.getProject(String(projectId)) },
    { name: 'vpa-project-revision', pattern: 'vpa://projects/{projectId}/revision', title: 'VPA project revision', read: ({ projectId }) => automation.getProjectRevision(String(projectId)) },
    { name: 'vpa-project-feedback', pattern: 'vpa://projects/{projectId}/feedback', title: 'VPA project feedback', read: ({ projectId }) => automation.listFeedback(String(projectId)) },
    { name: 'vpa-project-render', pattern: 'vpa://projects/{projectId}/render', title: 'VPA project render status', read: ({ projectId }) => automation.getRenderStatus(String(projectId)) },
    { name: 'vpa-job', pattern: 'vpa://jobs/{jobId}', title: 'VPA job', read: ({ jobId }) => automation.getJob(String(jobId)) },
  ];
  for (const template of templates) {
    server.registerResource(template.name, new ResourceTemplate(template.pattern, { list: undefined }), {
      title: template.title, mimeType: 'application/json',
    }, async (uri, variables) => jsonResource(uri, await template.read(variables)));
  }

  return server;
}
