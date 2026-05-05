/**
 * Convert a monologue narration script into a two-speaker dialog version.
 * Pure function — does not touch storyboard state. Callers persist the
 * result however they need.
 *
 * Used by:
 *   1. POST /scripts/generate — auto-generates the dialog alongside the
 *      monologue so flipping modes is instant.
 *   2. POST /narration/convert-dialog — explicit user-triggered conversion.
 */

import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import { withReferenceContext } from '../project-source-docs/inject.js';

export interface DialogChunk {
  index: number;
  text: string;
  speaker: string; // 'A' | 'B'
}

export interface ConvertToDialogResult {
  /** Full dialog script with [Speaker A] / [Speaker B] paragraph prefixes preserved. */
  dialogScript: string;
  /** Paragraph-split chunks with detected speaker assignments and prefix-stripped text. */
  chunks: DialogChunk[];
}

const FALLBACK_SYSTEM_PROMPT =
  'Convert the following narration monologue into a natural two-person dialog ' +
  'between Speaker A and Speaker B. Prefix each paragraph with [Speaker A] or ' +
  '[Speaker B]. Keep total word count similar. Return only the script.';

/** Same paragraph splitter the narration service uses, but inlined to keep this
 *  module dependency-light. Splits on a blank line OR on the start of a new
 *  [Speaker X] block, which is what the LLM emits. */
function splitDialogParagraphs(script: string): string[] {
  if (!script) return [];
  const lines = script.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  // Some LLMs put speaker labels on consecutive lines without blank rows between
  // them — split anything that has a [Speaker X] mid-string.
  const result: string[] = [];
  for (const para of lines) {
    const matches = para.split(/(?=\[Speaker\s+[AB]\])/i).map((s) => s.trim()).filter(Boolean);
    result.push(...matches);
  }
  return result;
}

export async function convertToDialog(
  monologueScript: string,
  llm: LlmClient,
  workspaceRoot: string,
  /** Optional — when provided, project source-docs are prepended to the prompt. */
  projectPath?: string,
): Promise<ConvertToDialogResult> {
  let systemPrompt: string;
  try {
    systemPrompt = await loadPrompt(workspaceRoot, 'narration-convert-dialog');
  } catch {
    systemPrompt = FALLBACK_SYSTEM_PROMPT;
  }

  const baseUserPrompt = `Convert this narration script to dialog:\n\n${monologueScript}`;
  const userPrompt = await withReferenceContext(baseUserPrompt, {
    projectPath,
    summarize: true,
    llm,
  });

  const result = await llm.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.7,
  });

  const dialogScript = result.text.trim();
  const paragraphs = splitDialogParagraphs(dialogScript);
  const chunks: DialogChunk[] = paragraphs.map((text, i) => {
    const speakerMatch = text.match(/^\[Speaker\s+(A|B)\]/i);
    return {
      index: i,
      // Strip the speaker prefix from chunk text so per-chunk TTS doesn't read it aloud
      text: speakerMatch ? text.replace(/^\[Speaker\s+(?:A|B)\]\s*/i, '') : text,
      speaker: speakerMatch ? speakerMatch[1]!.toUpperCase() : (i % 2 === 0 ? 'A' : 'B'),
    };
  });

  return { dialogScript, chunks };
}
