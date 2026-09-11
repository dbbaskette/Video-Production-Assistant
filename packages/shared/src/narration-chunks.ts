import { parsePauses } from './pause-parser.js';
/** Split script into paragraphs (chunks) by double-newline. */
export function splitIntoParagraphs(script: string): string[] {
  return script
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Split a dialog script into chunks — one per speaker turn.
 * Each line starting with [Speaker X] becomes its own chunk.
 * Falls back to paragraph splitting if no speaker tags found.
 */
export function splitDialogIntoChunks(script: string): string[] {
  // Split on newline before [Speaker X] tags
  const chunks = script
    .split(/\n(?=\[Speaker [A-Z]\])/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // Fall back to paragraph splitting if no speaker tags
  return chunks.length > 1 ? chunks : splitIntoParagraphs(script);
}

export interface ScriptChunk {
  text: string;
  gapSec: number;
}

/**
 * Pause-aware chunk derivation — the SINGLE source of chunk boundaries. Every
 * site that derives chunks from a script (generation, failure stubs, the GET
 * narration route) must use this so indices stay aligned.
 *
 * Composes `[pause Xs]` parsing (over the whole script, so a pause on its own
 * line between paragraphs folds correctly) with the existing paragraph / dialog
 * split. A pause's gap lands on the LAST paragraph of the text preceding it.
 */
export function splitScriptIntoChunks(script: string, isDialog: boolean): ScriptChunk[] {
  const out: ScriptChunk[] = [];
  // In dialog mode a `[pause Xs]` mid-turn splits a speaker's line; the
  // continuation would otherwise lose its `[Speaker X]` prefix and resolve to
  // the wrong voice. Carry the last-seen speaker onto such continuations.
  let lastSpeaker: string | null = null;
  for (const seg of parsePauses(script)) {
    const paras = isDialog ? splitDialogIntoChunks(seg.text) : splitIntoParagraphs(seg.text);
    if (paras.length === 0) continue;
    paras.forEach((para, i) => {
      let text = para;
      if (isDialog) {
        const m = text.match(/^\[Speaker ([A-Z])\]/);
        if (m) lastSpeaker = m[1]!;
        else if (lastSpeaker) text = `[Speaker ${lastSpeaker}] ${text}`;
      }
      // The pause gap attaches after the last paragraph of this segment.
      out.push({ text, gapSec: i === paras.length - 1 ? seg.gapSec : 0 });
    });
  }
  return out;
}
