import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import { DEFAULT_WPM } from './wpm.js';

export interface TightenInput {
  /** The existing script to compress. */
  currentScript: string;
  /** Target spoken duration in seconds — drives the target word count. */
  targetDurationSec: number;
  /**
   * Project's measured TTS rate (words per minute). Caller should pass the
   * empirical value from `computeProjectWpm()` when chunks exist, else
   * accept the default. Keeping this on TightenInput rather than baked
   * into the service lets the route compute it once per request and pass
   * it through.
   */
  wpm?: number;
  /** Optional context so the model knows what scene it's editing. */
  sceneName?: string;
  sceneIntent?: string;
}

export interface TightenResult {
  proposedScript: string;
  currentWords: number;
  targetWords: number;
  proposedWords: number;
  /**
   * Why the tightener didn't produce a strict reduction (when it didn't):
   *   - 'already_fits': input was already under target → no LLM call made
   *   - 'no_safe_cut': LLM call(s) returned a script that wasn't shorter,
   *                    so we fell back to the original
   * Absent when the proposal IS shorter than the input.
   */
  reason?: 'already_fits' | 'no_safe_cut';
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function buildUserPrompt(
  input: TightenInput,
  targetWords: number,
  currentWords: number,
  stricter: boolean,
): string {
  const lines: string[] = [];
  if (input.sceneName) lines.push(`Scene: ${input.sceneName}`);
  if (input.sceneIntent) lines.push(`What this scene is demonstrating: ${input.sceneIntent}`);
  lines.push(`Target duration: ${input.targetDurationSec.toFixed(1)} seconds`);
  lines.push(`Target word count: ${targetWords} words or fewer (current: ${currentWords} words)`);
  lines.push(`You must remove at least ${Math.max(1, currentWords - targetWords)} words.`);
  if (stricter) {
    lines.push('');
    lines.push(
      'IMPORTANT: a previous attempt returned a script that was the same length ' +
      'or longer than the input. That is a failure. This time, be aggressive — ' +
      'cut entire sentences if you have to. The output MUST be shorter.',
    );
  }
  lines.push('');
  lines.push('Current script:');
  lines.push(input.currentScript);
  return lines.join('\n');
}

export async function tightenScript(
  input: TightenInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<TightenResult> {
  const currentWords = wordCount(input.currentScript);
  const wpm = input.wpm && input.wpm > 0 ? input.wpm : DEFAULT_WPM;
  const targetWords = Math.max(20, Math.round((input.targetDurationSec / 60) * wpm));

  // Already fits the target — there's no useful work for the LLM. Returning a
  // no-op result lets the UI message clearly ("script already fits") and
  // saves a token-burning round trip that would only have invited the model
  // to invent elaboration to "fill" the duration.
  if (currentWords <= targetWords) {
    return {
      proposedScript: input.currentScript,
      currentWords,
      targetWords,
      proposedWords: currentWords,
      reason: 'already_fits',
    };
  }

  const systemPrompt = await loadPrompt(workspaceRoot, 'narration-tighten');

  // First attempt: standard prompt.
  let attempt = await llm.complete({
    systemPrompt,
    userPrompt: buildUserPrompt(input, targetWords, currentWords, false),
  });
  let proposed = attempt.text.trim();
  let proposedWords = wordCount(proposed);

  // If the model returned something that isn't strictly shorter, give it one
  // more shot with a sharpened instruction. Around half the time this is
  // enough; the other half we return the original below.
  if (proposedWords >= currentWords) {
    attempt = await llm.complete({
      systemPrompt,
      userPrompt: buildUserPrompt(input, targetWords, currentWords, true),
    });
    proposed = attempt.text.trim();
    proposedWords = wordCount(proposed);
  }

  // Still not shorter? Surface the original as the "proposal" and tag the
  // reason so the UI can tell the user the tighten couldn't find anything
  // safe to cut — rather than offering a same-length or longer rewrite they
  // never asked for.
  if (proposedWords >= currentWords) {
    return {
      proposedScript: input.currentScript,
      currentWords,
      targetWords,
      proposedWords: currentWords,
      reason: 'no_safe_cut',
    };
  }

  return {
    proposedScript: proposed,
    currentWords,
    targetWords,
    proposedWords,
  };
}
