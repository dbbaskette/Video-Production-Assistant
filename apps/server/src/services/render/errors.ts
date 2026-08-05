import { RenderError } from './scene-duration.js';

export type RenderFailureScope = 'scene' | 'project' | 'transition-preview' | 'thumbnail';

export interface PublicRenderFailure {
  statusCode: 400 | 500;
  code:
    | 'no_storyboard'
    | 'scene_not_found'
    | 'no_recording'
    | 'missing_duration'
    | 'precondition_failed'
    | 'scene_render_failed'
    | 'render_failed'
    | 'preview_failed'
    | 'thumb_failed';
  error: string;
  hint?: string;
}

const SAFE_PUBLIC_HINTS = new Set([
  'ffmpeg lacks freetype — see /setup, then reinstall via homebrew-ffmpeg/ffmpeg/ffmpeg',
  'ffmpeg lacks libass — disable subtitle burn-in or rebuild ffmpeg with --enable-libass',
  'A scene recording or audio file is malformed — re-encode the source',
  'Scenes have inconsistent timestamps — concat will retry with re-encode',
]);

const MAX_PRIVATE_DIAGNOSTIC_CHARS = 2_000;

function boundedRedactedDiagnostic(value: string): string {
  // Redact the original diagnostic before selecting a bounded tail. Truncating
  // first can cut off `--token` while retaining the end of a long secret.
  const redacted = value
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[redacted secret]')
    .replace(/\bBearer\s+(?!\[redacted secret\])[^\s]+/gi, 'Bearer [redacted secret]')
    .replace(/(--(?:api[_-]?key|token|secret|password|credential)\s+)[^\s]+/gi, '$1[redacted secret]')
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted secret]')
    // Quoting provides an unambiguous boundary for paths containing spaces.
    .replace(/(["'])(\/(?=[^"'`\r\n]*\/)[^"'`\r\n]+)\1/g, '$1[redacted path]$1')
    .replace(
      /(["'])(\/[^"'`\r\n]+?\.(?:mp4|mov|mkv|webm|mp3|wav|aac|m4a|srt|vtt|png|jpe?g|webp|gif|json|ya?ml|txt|md|log))\1/gi,
      '$1[redacted path]$1',
    )
    // Unquoted ffmpeg paths commonly live below these absolute roots. Require
    // a file-like suffix so ordinary prose such as "/ retry later" survives.
    .replace(
      /(^|[\s("'=])\/(?:Users|home|private|tmp|var|Volumes|opt|etc|usr|Library|Applications)\/[^\r\n"'`]*?\.(?:mp4|mov|mkv|webm|mp3|wav|aac|m4a|srt|vtt|png|jpe?g|webp|gif|json|ya?ml|txt|md|log)(?=$|[.\s,;:)])/gim,
      '$1[redacted path]',
    )
    .replace(/file:\/\/[^\s"'`]+/gi, '[redacted path]')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '[redacted path]')
    .replace(/(^|[\s("'=])\/(?:[^/\s"'`]+\/)*[^/\s"'`]+/gm, '$1[redacted path]');
  return redacted.slice(-MAX_PRIVATE_DIAGNOSTIC_CHARS);
}

export function privateRenderDiagnostic(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name.slice(0, 120) : 'RenderError',
    message: boundedRedactedDiagnostic(message),
    ...(error instanceof RenderError && error.stderrTail
      ? { stderrTail: boundedRedactedDiagnostic(error.stderrTail) }
      : {}),
    ...(error instanceof RenderError && error.hint
      ? { hint: boundedRedactedDiagnostic(error.hint) }
      : {}),
  };
}

export function publicRenderFailure(
  error: unknown,
  scope: RenderFailureScope,
): PublicRenderFailure {
  const message = error instanceof Error ? error.message : '';
  if (/no storyboard/i.test(message)) {
    return {
      statusCode: 400,
      code: scope === 'scene' ? 'precondition_failed' : 'no_storyboard',
      error: 'No storyboard found.',
    };
  }
  if (/scene not found/i.test(message)) {
    return {
      statusCode: 400,
      code: scope === 'scene' ? 'precondition_failed' : 'scene_not_found',
      error: 'Scene not found.',
    };
  }
  if (/no (?:scene has a )?recording|scene has no recording/i.test(message)) {
    return {
      statusCode: 400,
      code: scope === 'scene' ? 'precondition_failed' : 'no_recording',
      error: 'Scene has no recording.',
    };
  }
  if (/recording duration is unavailable/i.test(message)) {
    return {
      statusCode: 400,
      code: scope === 'scene' ? 'precondition_failed' : 'missing_duration',
      error: 'Scene recording duration is unavailable.',
    };
  }

  const hint = error instanceof RenderError && error.hint && SAFE_PUBLIC_HINTS.has(error.hint)
    ? error.hint
    : undefined;
  const fallback = scope === 'scene'
    ? {
        code: 'scene_render_failed' as const,
        error: 'Scene rendering failed. Check the source media and try again.',
      }
    : scope === 'transition-preview'
      ? {
          code: 'preview_failed' as const,
          error: 'Transition preview failed. Check the source media and try again.',
        }
      : scope === 'thumbnail'
        ? {
            code: 'thumb_failed' as const,
            error: 'Thumbnail rendering failed. Check the source media and try again.',
          }
        : {
            code: 'render_failed' as const,
            error: 'Video rendering failed. Check the source media and try again.',
          };
  return {
    statusCode: 500,
    ...fallback,
    ...(hint ? { hint } : {}),
  };
}
