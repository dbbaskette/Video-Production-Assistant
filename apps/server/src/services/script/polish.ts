import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import { withReferenceContext } from '../project-source-docs/inject.js';
import { DEFAULT_WPM } from './wpm.js';

export interface PolishInput {
  /** The user-authored draft script to evaluate and polish. Primary content. */
  draft: string;
  /**
   * Target spoken duration in seconds — drives the target word count so the
   * polish fits the recording. Optional: when absent (no recording yet) the
   * polish improves quality + emotives only and is not fitted to length.
   */
  targetDurationSec?: number;
  /**
   * Project's measured TTS rate (words per minute). Caller passes the
   * empirical value from `computeProjectWpm()`; falls back to the 150
   * default when omitted. Only used when `targetDurationSec` is present.
   */
  wpm?: number;
  /** Optional context so the polisher knows what scene it's editing. */
  sceneName?: string;
  sceneIntent?: string;
  projectObjective?: string;
  projectAudience?: string;
  /** When provided, the project's source-docs are injected into the prompt. */
  projectPath?: string;
}

export interface PolishResult {
  /** The polished narration (with emotive tags). */
  proposedScript: string;
  /** Short evaluation bullets — what changed and why. Empty on parse fallback. */
  notes: string[];
  currentWords: number;
  proposedWords: number;
  /** Target word count for the recording. Undefined when no duration was given. */
  targetWords?: number;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Strip a leading/trailing markdown code fence (```json … ```), if present,
 * so JSON.parse sees the raw object. Models sometimes wrap JSON output in a
 * fence even when asked not to.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * Parse the model's `{ notes, script }` response defensively. On any failure
 * (not JSON, wrong shape) we fall back to treating the entire response as the
 * polished script with no notes — the user still gets a usable proposal.
 */
function parseResponse(raw: string): { script: string; notes: string[] } {
  const cleaned = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { script?: unknown }).script === 'string'
    ) {
      const obj = parsed as { script: string; notes?: unknown };
      const notes = Array.isArray(obj.notes)
        ? obj.notes.filter((n): n is string => typeof n === 'string')
        : [];
      return { script: obj.script.trim(), notes };
    }
  } catch {
    // fall through to plain-text fallback
  }
  return { script: raw.trim(), notes: [] };
}

function buildUserPrompt(input: PolishInput, targetWords?: number): string {
  const lines: string[] = [];
  if (input.sceneName) lines.push(`Scene name: ${input.sceneName}`);
  if (input.sceneIntent) {
    lines.push(`What this scene is demonstrating (north star): ${input.sceneIntent}`);
  }
  if (input.projectObjective) lines.push(`Project objective: ${input.projectObjective}`);
  if (input.projectAudience) lines.push(`Target audience: ${input.projectAudience}`);
  if (targetWords) {
    lines.push(`Target word count: ~${targetWords} words (edit the draft to fit this length).`);
  } else {
    lines.push('No recording length is available — polish for quality only, do not fit to a word count.');
  }
  lines.push('');
  lines.push("The user's draft script (polish this):");
  lines.push(input.draft);
  return lines.join('\n');
}

/**
 * Ask the LLM to evaluate + editorially polish a user-supplied draft: improve
 * pacing/clarity/flow, add emotive tags, and fit it to the recording length
 * when a duration is provided. Returns the proposal WITHOUT saving — the route
 * hands it to the client for review.
 */
export async function polishScript(
  input: PolishInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<PolishResult> {
  const currentWords = wordCount(input.draft);

  let targetWords: number | undefined;
  if (input.targetDurationSec && input.targetDurationSec > 0) {
    const wpm = input.wpm && input.wpm > 0 ? input.wpm : DEFAULT_WPM;
    targetWords = Math.max(20, Math.round((input.targetDurationSec / 60) * wpm));
  }

  const systemPrompt = await loadPrompt(workspaceRoot, 'narration-polish');

  const userPrompt = await withReferenceContext(buildUserPrompt(input, targetWords), {
    projectPath: input.projectPath,
    summarize: true,
    llm,
  });

  const result = await llm.complete({
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
    temperature: 0.6,
  });

  const { script, notes } = parseResponse(result.text);

  return {
    proposedScript: script,
    notes,
    currentWords,
    proposedWords: wordCount(script),
    targetWords,
  };
}
