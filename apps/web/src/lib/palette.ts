/**
 * Centralized colour palette + status vocabulary.
 *
 * Why this file exists: before this, three parallel literal-hex const blocks
 * lived in ScenePage, StoryboardView, and ReviewPage with overlapping but
 * not-quite-matching meanings, and `#5e8a3a` was hardcoded in six places
 * for "success" while `--success` was `#73c05a`. Same data was labeled
 * "Pass / N issues / N warns" on Project Overview and "All Good / Issues
 * Found / Warnings Found" on ReviewPage. This module is the single source
 * of truth for both.
 *
 * Rules:
 *   - Anywhere you'd write a literal hex for a status colour, import from here
 *     instead. The values themselves resolve to the existing CSS custom
 *     properties in styles.css so theme changes propagate.
 *   - Any text that describes status uses the exact strings exported below.
 */

// ── Status colours ──────────────────────────────────────────────────
// Resolve via CSS variables so the theme system stays the source of truth.
export const STATUS_COLOR = {
  success: 'var(--success)',
  successBg: 'var(--success-bg)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  dangerBg: 'var(--danger-bg)',
  muted: 'var(--fg-muted)',
} as const;

// ── Severity (review items) ─────────────────────────────────────────
export const SEVERITY_COLOR: Record<'info' | 'warn' | 'issue', string> = {
  info: 'var(--fg-muted)',
  warn: STATUS_COLOR.warn,
  issue: STATUS_COLOR.danger,
};

// ── Scene-type chip palette ─────────────────────────────────────────
// Used on the storyboard rail + scene page header. Same hexes as the
// previous parallel const blocks — single source now.
export const SCENE_TYPE_COLOR: Record<'desktop' | 'terminal' | 'browser' | 'slide', string> = {
  desktop: '#7aa2f7',  // matches --accent
  terminal: '#73c05a', // matches --success
  browser: '#f4a83a',  // matches --warn
  slide: '#c25d5d',
};

// ── Status vocabulary ───────────────────────────────────────────────
// One way to describe each state across the app. Don't invent synonyms.
export type ReviewStatus = 'ready' | 'warnings' | 'issues' | 'unrun';

export function reviewSummaryLabel(
  status: ReviewStatus,
  counts: { warnings: number; issues: number },
): string {
  if (status === 'unrun') return 'Not yet run';
  if (status === 'issues') return `${counts.issues} issue${counts.issues === 1 ? '' : 's'}`;
  if (status === 'warnings') return `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`;
  return 'Ready';
}

export function reviewSummaryColor(status: ReviewStatus): string {
  if (status === 'issues') return STATUS_COLOR.danger;
  if (status === 'warnings') return STATUS_COLOR.warn;
  if (status === 'ready') return STATUS_COLOR.success;
  return STATUS_COLOR.muted;
}

// ── Form scale ──────────────────────────────────────────────────────
// One scale for sizing form bits. If you find yourself writing
// `fontSize: 10` or `fontSize: 14` inline, use these instead.
export const FORM_SIZE = {
  /** Field labels — uppercase tracked. */
  labelPx: 11,
  /** Inputs, textareas, selects, helper text inside form rows. */
  inputPx: 13,
  /** Helper text below a field, status pips, hints. */
  helperPx: 12,
} as const;
