/**
 * Claude Code CLI provider.
 *
 * Spawns `claude -p` in headless mode with `--output-format stream-json`,
 * parses the streaming output, and returns the assistant's text response.
 * Uses the user's Claude subscription — no API key required.
 *
 * Ported from TVP's claude-cli.ts pattern.
 */

import { spawn } from 'node:child_process';
import type { LlmClient, LlmCompleteOptions, LlmCompletion } from '../index.js';

// ---------------------------------------------------------------------------
// stream-json event parser
// ---------------------------------------------------------------------------

interface StreamEvent {
  type?: string;
  subtype?: string;
  result?: string;
  error?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

function parseStreamEvent(raw: string): { text: string; costUsd?: number; error?: string } {
  let event: StreamEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return { text: '' };
  }

  if (event.type === 'result') {
    const costUsd = event.total_cost_usd;
    if (event.is_error || event.subtype === 'error') {
      return { text: '', costUsd, error: String(event.result ?? event.error ?? 'unknown error') };
    }
    let resultText = typeof event.result === 'string' ? event.result : '';
    // Strip any skill/tool noise injected by hooks
    resultText = resultText.replace(/<function_calls>[\s\S]*?<\/function_calls>\s*/g, '');
    resultText = resultText.replace(/<function_calls>[\s\S]*?<\/antml:function_calls>\s*/g, '');
    resultText = resultText.replace(/^.*(?:Using the|Invoking the).*\b[Ss]kill\b.*tool[^\n]*\n*/gm, '');
    return { text: resultText.trim(), costUsd };
  }

  return { text: '' };
}

// ---------------------------------------------------------------------------
// Core subprocess runner
// ---------------------------------------------------------------------------

interface RunOptions {
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
}

async function runClaude(userPrompt: string, opts: RunOptions = {}): Promise<string> {
  const model = opts.model ?? process.env.VPA_LLM_MODEL ?? 'sonnet';
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const args = [
    '-p',
    '--output-format', 'stream-json',
    // `--max-turns 1` is too tight: `--tools ""` only disables built-ins, so
    // plugin-provided tools (LSP) and user MCPs still load. If the model
    // decides to call any of those, the tool call consumes the single allowed
    // turn and the follow-up text turn never fires → empty response with
    // `result:error_max_turns`. 3 leaves room for one optional tool round-trip
    // plus the final text reply.
    '--max-turns', '3',
    '--model', model,
    '--verbose',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    '--tools', '',  // disables built-ins (plugins/MCPs still load)
  ];

  if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }

  return new Promise<string>((resolve, reject) => {
    // Remove CLAUDECODE env var to avoid nested-session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // Write prompt to stdin — avoids OS argument length limits on large prompts
    proc.stdin?.write(userPrompt);
    proc.stdin?.end();

    let textParts: string[] = [];
    let lastError: string | undefined;
    let buffer = '';
    let timedOut = false;
    const rawEvents: string[] = []; // diagnostic: capture event types

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line.trim()); rawEvents.push(`${e.type}:${e.subtype ?? ''}`); } catch {}
        const parsed = parseStreamEvent(line.trim());
        if (parsed.text) textParts.push(parsed.text);
        if (parsed.error) lastError = parsed.error;
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Flush remaining buffer
      if (buffer.trim()) {
        const parsed = parseStreamEvent(buffer.trim());
        if (parsed.text) textParts.push(parsed.text);
        if (parsed.error) lastError = parsed.error;
      }

      if (timedOut) {
        reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
        return;
      }

      const text = textParts.join('\n');
      if (!text) {
        console.error(`[claude-code] Empty response. Exit code: ${code}`);
        console.error(`[claude-code] Events received: ${rawEvents.join(', ')}`);
        if (stderrBuf.trim()) {
          console.error(`[claude-code] stderr: ${stderrBuf.trim().slice(0, 500)}`);
        }
        if (lastError) {
          console.error(`[claude-code] Last error: ${lastError}`);
        }
        const detail = lastError ?? stderrBuf.trim().slice(0, 300) ?? `exit code ${code}`;
        reject(new Error(`claude -p returned empty response: ${detail}`));
        return;
      }

      resolve(text);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}. Is Claude Code installed?`));
    });
  });
}

// ---------------------------------------------------------------------------
// LlmClient implementation
// ---------------------------------------------------------------------------

export function createClaudeCodeLlm(model?: string): LlmClient {
  return {
    async complete(opts: LlmCompleteOptions): Promise<LlmCompletion> {
      let userPrompt = opts.userPrompt;

      // For JSON responses, append an instruction so the CLI returns parseable output
      if (opts.responseFormat === 'json') {
        userPrompt += '\n\nRespond with valid JSON only. No markdown fencing, no explanation.';
      }

      const text = await runClaude(userPrompt, {
        systemPrompt: opts.systemPrompt,
        model,
      });

      return { text };
    },
  };
}
