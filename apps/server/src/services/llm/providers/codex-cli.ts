import { resolve } from 'node:path';
import type { LlmClient, LlmCompleteOptions, LlmCompletion } from '../index.js';
import {
  runJsonlProcess,
  type JsonlProcessRequest,
  type JsonlProcessResult,
} from '../../process/jsonl-process.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface CodexCliLlmDeps {
  executable?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runProcess?: (request: JsonlProcessRequest) => Promise<JsonlProcessResult>;
}

function defaultWorkspaceRoot(): string {
  return resolve(import.meta.dirname, '../../../../../..');
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function codexEventError(event: Record<string, unknown>): string | undefined {
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'error' && type !== 'turn.failed') return undefined;
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim();
  const error = nestedRecord(event.error);
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  return type === 'turn.failed' ? 'Codex turn failed' : 'Codex CLI reported an error';
}

export function finalCodexAgentMessage(events: Array<Record<string, unknown>>): string | undefined {
  let text: string | undefined;
  for (const event of events) {
    if (event.type !== 'item.completed') continue;
    const item = nestedRecord(event.item);
    if (item?.type !== 'agent_message' || typeof item.text !== 'string') continue;
    if (item.text.trim()) text = item.text.trim();
  }
  return text;
}

function promptFor(opts: LlmCompleteOptions): string {
  let userPrompt = opts.userPrompt;
  if (opts.responseFormat === 'json') {
    userPrompt += '\n\nRespond with valid JSON only. No markdown fencing, no explanation.';
  }
  return `${opts.systemPrompt}\n\n${userPrompt}`;
}

/** Ordinary LLM provider backed by the user's authenticated Codex CLI. */
export function createCodexCliLlm(model?: string, deps: CodexCliLlmDeps = {}): LlmClient {
  const executable = deps.executable ?? 'codex';
  const workspaceRoot = deps.workspaceRoot ?? defaultWorkspaceRoot();
  const runProcess = deps.runProcess ?? runJsonlProcess;

  return {
    async complete(opts: LlmCompleteOptions): Promise<LlmCompletion> {
      const args = ['exec', '--ephemeral', '--json', '--sandbox', 'read-only', '-C', workspaceRoot];
      if (model && model !== 'default') args.push('--model', model);
      args.push('-');

      const result = await runProcess({
        executable,
        args,
        cwd: workspaceRoot,
        stdin: promptFor(opts),
        env: deps.env ?? process.env,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      for (const event of result.events) {
        const error = codexEventError(event);
        if (error) throw new Error(`Codex CLI failed: ${error}`);
      }

      const text = finalCodexAgentMessage(result.events);
      if (!text) {
        const diagnostic = result.stderr.trim();
        throw new Error(
          `Codex CLI returned no completed agent message${diagnostic ? `: ${diagnostic}` : ''}`,
        );
      }
      return { text, raw: result.events };
    },
  };
}
