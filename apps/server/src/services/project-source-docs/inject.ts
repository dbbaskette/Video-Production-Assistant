/**
 * Tiny helper used by every "creative" LLM call to inject a project's
 * source-docs reference block into the userPrompt. No-op when the project
 * has no docs or when projectPath is omitted (lets pre-existing call sites
 * stay backward-compatible).
 */

import { getReferenceContext } from './context.js';
import type { LlmClient } from '../llm/index.js';

export interface InjectOptions {
  projectPath?: string;
  /** When set, summarise the bundle if it exceeds the budget. */
  summarize?: boolean;
  /** Required when `summarize` is true. */
  llm?: LlmClient;
}

/** Returns `${ref}\n\n---\n\n${userPrompt}` when there are docs; otherwise `userPrompt`. */
export async function withReferenceContext(
  userPrompt: string,
  opts: InjectOptions = {},
): Promise<string> {
  if (!opts.projectPath) return userPrompt;
  const ref = await getReferenceContext(opts.projectPath, {
    summarize: opts.summarize,
    llm: opts.llm,
  });
  if (!ref.text) return userPrompt;
  return `${ref.text}\n\n---\n\n${userPrompt}`;
}
