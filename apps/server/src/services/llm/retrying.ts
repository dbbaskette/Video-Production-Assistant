/**
 * RetryingLlm wraps another `LlmClient` and retries the call on transient
 * failures (HTTP 429 rate-limit, 5xx server errors, and network resets).
 *
 * Permanent failures (4xx other than 429, plus things like "no API key" or
 * malformed-prompt errors) propagate immediately — those usually indicate a
 * real problem and retrying makes them slower without helping.
 *
 * The retry strategy is exponential backoff with jitter:
 *   attempt 1: 1.0–1.5 s
 *   attempt 2: 2.0–3.0 s
 *   attempt 3: 4.0–6.0 s   (only used for 429s)
 *
 * Decisions are based on the inner provider's Error.message — all current
 * providers stringify HTTP errors as `"... API error (NNN ...): ..."`.
 */

import type { LlmClient, LlmCompleteOptions, LlmCompletion } from './index.js';

export interface RetryConfig {
  max429Attempts: number;
  max5xxAttempts: number;
  maxNetworkAttempts: number;
  baseDelayMs: number;
}

const DEFAULTS: RetryConfig = {
  max429Attempts: 3,
  max5xxAttempts: 2,
  maxNetworkAttempts: 1,
  baseDelayMs: 1000,
};

type Classification = '429' | '5xx' | 'network' | 'permanent' | 'other';

function parseStatus(msg: string): number | null {
  const m = /\((\d{3})\b/.exec(msg);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

function classify(err: unknown): Classification {
  const message = err instanceof Error ? err.message : String(err);
  const status = parseStatus(message);
  if (status === 429) return '429';
  if (status !== null && status >= 500 && status < 600) return '5xx';
  if (status !== null && status >= 400 && status < 500) return 'permanent';
  const errName = err instanceof Error ? err.name : '';
  if (errName === 'TimeoutError') return 'network';
  if (/fetch failed|ECONN|ETIMED|ENOTFOUND|aborted|socket hang up|reset by peer/i.test(message)) {
    return 'network';
  }
  return 'other';
}

function delayFor(attempt: number, base: number): number {
  const exp = Math.pow(2, attempt - 1) * base;
  return exp + Math.random() * exp * 0.5;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export class RetryingLlm implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly config: RetryConfig = DEFAULTS,
    private readonly log?: (msg: string) => void,
  ) {}

  async complete(opts: LlmCompleteOptions): Promise<LlmCompletion> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.max429Attempts + 1; attempt++) {
      try {
        return await this.inner.complete(opts);
      } catch (err) {
        lastError = err;
        const kind = classify(err);
        const allowedRetries =
          kind === '429' ? this.config.max429Attempts :
          kind === '5xx' ? this.config.max5xxAttempts :
          kind === 'network' ? this.config.maxNetworkAttempts :
          0;
        if (allowedRetries === 0 || attempt > allowedRetries) {
          throw err;
        }
        const wait = delayFor(attempt, this.config.baseDelayMs);
        const reason = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
        this.log?.(`LLM ${kind} on attempt ${attempt}, retrying in ${Math.round(wait)}ms: ${reason}`);
        await sleep(wait);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
