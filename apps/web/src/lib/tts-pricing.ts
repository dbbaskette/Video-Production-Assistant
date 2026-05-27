/**
 * TTS provider pricing — per-character cost estimates surfaced in any
 * UI that generates speech (Quick TTS scratchpad, scene narration). Kept
 * deliberately small and data-driven; nothing here hits the network.
 *
 * Sources (last reviewed 2026-05):
 *   xAI       $15.00 / 1M characters
 *   Gemini    free during preview (Google API quota applies)
 *   Qwen      runs locally via mlx_audio (compute only, no per-char fee)
 *   Fake      placeholder provider used for tests
 *
 * When prices change, update the table below. The UI auto-picks up the
 * new numbers — there's no other place to edit.
 */

export interface TtsEnginePrice {
  /** USD per single character. 0 for free providers. */
  perChar: number;
  /** Short human label e.g. "$15.00 / 1M chars" or "local". */
  rate: string;
  /** Reason a free engine is free — shown alongside "free" so the user
   *  understands the asterisk ("local", "preview tier", etc.). */
  freeNote?: string;
}

const PRICING: Record<string, TtsEnginePrice> = {
  xai: {
    perChar: 15 / 1_000_000,
    rate: '$15.00 / 1M chars',
  },
  gemini: {
    perChar: 0,
    rate: 'free (preview)',
    freeNote: 'preview tier',
  },
  qwen: {
    perChar: 0,
    rate: 'local model',
    freeNote: 'local',
  },
  fake: {
    perChar: 0,
    rate: 'test provider',
    freeNote: 'test',
  },
};

/** Lookup price for an engine id. Unknown engines return undefined so
 *  the UI can degrade to "—" instead of guessing. */
export function getTtsPrice(engineId: string): TtsEnginePrice | undefined {
  return PRICING[engineId];
}

export interface TtsCostEstimate {
  /** Engine identifier — passed through verbatim. */
  engine: string;
  /** Raw character count used for the calculation. */
  chars: number;
  /** USD estimate. 0 for free engines, undefined when pricing unknown. */
  costUsd?: number;
  /** Whether this engine is free of per-char charges. */
  free: boolean;
  /** Human-readable rate label e.g. "$15.00 / 1M chars". */
  rate?: string;
  /** Short note explaining "free" providers ("local", "preview tier"). */
  freeNote?: string;
}

/** Estimate the cost of synthesizing `chars` characters with `engineId`. */
export function estimateTtsCost(engineId: string, chars: number): TtsCostEstimate {
  const price = PRICING[engineId];
  if (!price) {
    return { engine: engineId, chars, free: false };
  }
  return {
    engine: engineId,
    chars,
    costUsd: price.perChar * chars,
    free: price.perChar === 0,
    rate: price.rate,
    freeNote: price.freeNote,
  };
}

/** Format a USD amount for display next to a generate button. Uses
 *  "<$0.01" below the penny so users never see a zero that isn't free. */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return '<$0.01';
  if (amount < 1) return `$${amount.toFixed(2)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(0)}`;
}

/** One-line cost label for inline UI ("~$0.04 · xAI" / "free · local"). */
export function formatCostLabel(estimate: TtsCostEstimate): string {
  if (estimate.costUsd === undefined) return '—';
  if (estimate.free) {
    return estimate.freeNote ? `free · ${estimate.freeNote}` : 'free';
  }
  return `~${formatUsd(estimate.costUsd)}`;
}
