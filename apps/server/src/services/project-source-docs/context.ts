/**
 * Build a "Reference Materials" context block from a project's source-docs.
 * Every "creative" LLM call (ideation, scene description, script, lower
 * thirds, dialog conversion, quality review) prepends the result of
 * `getReferenceContext(projectPath)` to its userPrompt so generated content
 * is grounded in the docs the user uploaded.
 *
 * Strategy:
 *   1. Read all docs from the project's manifest (skipping any with empty
 *      extracted text).
 *   2. If the total fits under MAX_CHARS, concatenate as-is with `## <name>`
 *      headers between them.
 *   3. If the total is over MAX_CHARS, optionally summarise via the LLM
 *      (cheaper round-trip than truncation when the user opts in).
 *
 * Summarisation is opt-in. The default is to truncate evenly across docs
 * so we never silently drop parts of the user's reference material — the
 * caller can pass `summarize: true` and an LlmClient when they want a
 * compressed view.
 */

import { listDocs, readExtracted, isReady, type SourceDoc } from './index.js';
import type { LlmClient } from '../llm/index.js';

/** Soft budget for the assembled reference block, in characters. */
export const REFERENCE_BUDGET_CHARS = 30_000;

interface ContextOptions {
  /** Override the budget. */
  budget?: number;
  /** When true and the total exceeds the budget, summarise via the LLM. */
  summarize?: boolean;
  /** Required when `summarize` is true. */
  llm?: LlmClient;
}

export interface ReferenceBundle {
  /** The "## Reference Materials\n\n…" block ready to prepend to a prompt.
   *  Empty string when there are no docs. */
  text: string;
  /** Number of docs included. */
  docCount: number;
  /** Total length of the assembled block (after truncation/summarisation). */
  chars: number;
  /** True when the original docs were larger than budget. */
  truncated: boolean;
  /** True when the bundle was reduced via the summarise path. */
  summarised: boolean;
}

export async function getReferenceContext(
  projectPath: string,
  opts: ContextOptions = {},
): Promise<ReferenceBundle> {
  // Only 'ready' docs have extracted markdown on disk. A doc still
  // 'extracting' in the background (or one whose extraction failed) is
  // skipped so an LLM call fired right after upload never reads a
  // half-written or missing extract.
  const docs = (await listDocs(projectPath)).filter(isReady);
  if (docs.length === 0) {
    return { text: '', docCount: 0, chars: 0, truncated: false, summarised: false };
  }

  const budget = opts.budget ?? REFERENCE_BUDGET_CHARS;
  const totalChars = docs.reduce((acc, d) => acc + d.extractedChars, 0);
  const fitsRaw = totalChars <= budget;

  // Read all docs up-front so callers see consistent ordering.
  const loaded = await Promise.all(
    docs.map(async (d) => ({ doc: d, body: (await readExtracted(projectPath, d)).trim() })),
  );

  if (fitsRaw) {
    const text = formatBundle(loaded);
    return {
      text,
      docCount: docs.length,
      chars: text.length,
      truncated: false,
      summarised: false,
    };
  }

  // Over budget: prefer summarisation if the caller wired it; otherwise
  // truncate proportionally so each doc still contributes.
  if (opts.summarize && opts.llm) {
    try {
      const summarised = await summariseBundle(loaded, opts.llm, budget);
      return {
        text: summarised,
        docCount: docs.length,
        chars: summarised.length,
        truncated: false,
        summarised: true,
      };
    } catch {
      // Fall through to truncation if the LLM call fails.
    }
  }

  const truncated = formatBundle(loaded, budget);
  return {
    text: truncated,
    docCount: docs.length,
    chars: truncated.length,
    truncated: true,
    summarised: false,
  };
}

/** Concatenate docs with headers, optionally truncating each proportionally. */
function formatBundle(
  loaded: Array<{ doc: SourceDoc; body: string }>,
  hardCap?: number,
): string {
  const headerOverheadPerDoc = 80; // "## name\n\n" + small margin
  const total = loaded.reduce((acc, l) => acc + l.body.length, 0);

  let perDocBudget = Infinity;
  if (hardCap !== undefined) {
    const available = Math.max(hardCap - loaded.length * headerOverheadPerDoc, 1000);
    if (total > available) {
      // Distribute the available space proportionally to each doc's size
      perDocBudget = Math.max(500, Math.floor(available / loaded.length));
    }
  }

  const parts: string[] = ['## Reference Materials', ''];
  for (const { doc, body } of loaded) {
    parts.push(`### ${doc.name}`);
    if (doc.kind === 'url' && doc.url) parts.push(`*Source:* ${doc.url}`);
    parts.push('');
    if (body.length <= perDocBudget) {
      parts.push(body);
    } else {
      parts.push(body.slice(0, perDocBudget));
      parts.push(`\n\n*[truncated — original length ${body.length} chars]*`);
    }
    parts.push('');
  }
  return parts.join('\n').trim() + '\n';
}

/**
 * Use the LLM to compress source docs into a single Reference Materials
 * block under the budget. Each doc gets summarised individually so an
 * outage on one doesn't kill the whole bundle.
 */
async function summariseBundle(
  loaded: Array<{ doc: SourceDoc; body: string }>,
  llm: LlmClient,
  budget: number,
): Promise<string> {
  const perDocBudget = Math.max(800, Math.floor((budget - loaded.length * 100) / loaded.length));

  const summaries = await Promise.all(loaded.map(async ({ doc, body }) => {
    if (body.length <= perDocBudget) {
      return { doc, summary: body };
    }
    const result = await llm.complete({
      systemPrompt:
        `You compress reference documents for a video-production assistant. ` +
        `Preserve product names, technical claims, audience callouts, and ` +
        `any quoted figures or examples. Drop boilerplate, navigation cruft, ` +
        `and repetition. Output plain markdown only.`,
      userPrompt:
        `Compress the following document to roughly ${perDocBudget} characters ` +
        `while keeping the facts that would matter to someone writing a demo ` +
        `script about it.\n\n---\n\n${body}`,
      temperature: 0.2,
      maxTokens: Math.max(512, Math.floor(perDocBudget / 3)),
    });
    return { doc, summary: result.text.trim() };
  }));

  const parts: string[] = ['## Reference Materials', '*(LLM-summarised because the source docs exceeded the context budget.)*', ''];
  for (const { doc, summary } of summaries) {
    parts.push(`### ${doc.name}`);
    if (doc.kind === 'url' && doc.url) parts.push(`*Source:* ${doc.url}`);
    parts.push('');
    parts.push(summary);
    parts.push('');
  }
  return parts.join('\n').trim() + '\n';
}
