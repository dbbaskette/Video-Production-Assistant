import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AgentRehearsalEvidenceSchema,
  type AgentRehearsalEvidence,
} from '@vpa/shared';
import {
  runJsonlProcess,
  type JsonlProcessRequest,
  type JsonlProcessResult,
} from '../process/jsonl-process.js';
import { codexEventError, finalCodexAgentMessage } from '../llm/providers/codex-cli.js';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const checkpointJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'passed'],
  properties: {
    description: { type: 'string' },
    passed: { type: 'boolean' },
    detail: { type: 'string' },
  },
} as const;

export const REHEARSAL_EVIDENCE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'success',
    'targetApplication',
    'windowTitle',
    'windowBounds',
    'completedStepIndexes',
    'checkpoints',
    'resetConfirmed',
  ],
  properties: {
    success: { type: 'boolean' },
    targetApplication: { type: 'string' },
    windowTitle: { type: 'string' },
    windowBounds: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'width', 'height'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    completedStepIndexes: {
      type: 'array',
      items: { type: 'integer', minimum: 0 },
    },
    checkpoints: { type: 'array', items: checkpointJsonSchema },
    resetConfirmed: { type: 'boolean' },
    diagnostic: { type: 'string', maxLength: 2000 },
  },
} as const;

export const CodexExecutionEvidenceSchema = z.object({
  success: z.boolean(),
  completedStepIndexes: z.array(z.number().int().nonnegative()),
  checkpoints: z.array(z.object({
    description: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
  })),
  diagnostic: z.string().max(2000),
});
export type CodexExecutionEvidence = z.infer<typeof CodexExecutionEvidenceSchema>;

export const EXECUTION_EVIDENCE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['success', 'completedStepIndexes', 'checkpoints', 'diagnostic'],
  properties: {
    success: { type: 'boolean' },
    completedStepIndexes: {
      type: 'array',
      items: { type: 'integer', minimum: 0 },
    },
    checkpoints: { type: 'array', items: checkpointJsonSchema },
    diagnostic: { type: 'string', maxLength: 2000 },
  },
} as const;

const SAFETY_PROMPT = `Safety constraints (mandatory):
- Do not edit, create, delete, or move repository files.
- Do not run Cap commands or interact with Cap.
- Do not interact with any application other than the approved target application through the VPA desktop helper.
- Do not access, reveal, or store secrets.
- Do not upload or publish anything.
- Do not perform destructive actions.`;

export interface CodexRehearsalResult {
  threadId: string;
  evidence: AgentRehearsalEvidence;
}

export interface CodexSceneRunner {
  rehearse(
    prompt: string,
    sessionScratchDir: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<CodexRehearsalResult>;
  resumeForRecording(
    threadId: string,
    prompt: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<CodexExecutionEvidence>;
}

export interface CodexSceneRunnerDeps {
  executable?: string;
  timeoutMs?: number;
  runProcess?: (request: JsonlProcessRequest) => Promise<JsonlProcessResult>;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
}

function threadIdFrom(events: Array<Record<string, unknown>>): string | undefined {
  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
      return event.thread_id;
    }
  }
  return undefined;
}

function requireSuccessfulEvents(result: JsonlProcessResult): string {
  for (const event of result.events) {
    const error = codexEventError(event);
    if (error) throw new Error(`Codex CLI failed: ${error}`);
  }
  const message = finalCodexAgentMessage(result.events);
  if (!message) {
    const diagnostic = result.stderr.trim();
    throw new Error(
      `Codex CLI returned no completed agent message${diagnostic ? `: ${diagnostic}` : ''}`,
    );
  }
  return message;
}

function parseEvidence<T>(label: string, message: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new Error(`Codex returned malformed ${label} JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Codex returned invalid ${label}: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`);
  }
  return parsed.data;
}

export function createCodexSceneRunner(
  workspaceRoot: string,
  deps: CodexSceneRunnerDeps = {},
): CodexSceneRunner {
  const executable = deps.executable ?? 'codex';
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runProcess = deps.runProcess ?? runJsonlProcess;
  const makeDirectory = deps.mkdir ?? mkdir;
  const write = deps.writeFile ?? writeFile;

  return {
    async rehearse(prompt, sessionScratchDir, env, signal) {
      await makeDirectory(sessionScratchDir, { recursive: true });
      const schemaPath = path.join(sessionScratchDir, 'rehearsal-output.schema.json');
      await write(schemaPath, `${JSON.stringify(REHEARSAL_EVIDENCE_JSON_SCHEMA, null, 2)}\n`, 'utf8');

      // thread.started is normally the first event and can age out of the
      // process adapter's bounded event history during a long rehearsal.
      let streamedThreadId: string | undefined;
      const result = await runProcess({
        executable,
        args: [
          'exec',
          '--json',
          '--sandbox',
          'workspace-write',
          '--output-schema',
          schemaPath,
          '-C',
          workspaceRoot,
          '-',
        ],
        cwd: workspaceRoot,
        stdin: `${SAFETY_PROMPT}\n\n${prompt}\n\nReturn only rehearsal evidence that conforms to the supplied JSON Schema.`,
        env,
        timeoutMs,
        signal,
        onEvent: (event) => {
          streamedThreadId ??= threadIdFrom([event]);
        },
      });

      // The fallback keeps simple injected process doubles ergonomic.
      const message = requireSuccessfulEvents(result);
      const threadId = streamedThreadId ?? threadIdFrom(result.events);
      if (!threadId) throw new Error('Codex rehearsal did not return a thread ID');
      return {
        threadId,
        evidence: parseEvidence('rehearsal evidence', message, AgentRehearsalEvidenceSchema),
      };
    },

    async resumeForRecording(threadId, prompt, env, signal) {
      if (!threadId.trim()) throw new Error('Codex recording resume requires a thread ID');
      const result = await runProcess({
        executable,
        args: ['exec', 'resume', threadId, '--json', '-'],
        cwd: workspaceRoot,
        stdin: `${SAFETY_PROMPT}\n\n${prompt}\n\nReturn valid JSON only, with this schema:\n${JSON.stringify(EXECUTION_EVIDENCE_JSON_SCHEMA)}`,
        env,
        timeoutMs,
        signal,
      });
      return parseEvidence(
        'recording execution evidence',
        requireSuccessfulEvents(result),
        CodexExecutionEvidenceSchema,
      );
    },
  };
}
