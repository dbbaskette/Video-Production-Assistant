import { describe, expect, it } from 'vitest';
import { RenderError } from './scene-duration.js';
import { privateRenderDiagnostic, publicRenderFailure } from './errors.js';

describe('render failure boundaries', () => {
  it('returns a stable bounded public failure without command, path, secret, or stderr details', () => {
    const privatePath = '/Users/alice/private/project/source.mp4';
    const secret = 'private-bearer-value';
    const error = new RenderError(
      `Command failed: ffmpeg -i ${privatePath} -metadata token=${secret}`,
      {
        hint: `Inspect ${privatePath}`,
        stderrTail: `Invalid data in ${privatePath}\nAuthorization: Bearer ${secret}`,
      },
    );

    const failure = publicRenderFailure(error, 'scene');
    const serialized = JSON.stringify(failure);

    expect(failure).toEqual({
      statusCode: 500,
      code: 'scene_render_failed',
      error: 'Scene rendering failed. Check the source media and try again.',
    });
    expect(serialized).not.toContain('ffmpeg');
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Invalid data');
  });

  it('keeps redacted useful diagnostics private', () => {
    const privatePath = '/Users/alice/private/project/source.mp4';
    const secret = 'private-bearer-value';
    const diagnostic = privateRenderDiagnostic(new RenderError(
      `ffmpeg failed for ${privatePath} --token ${secret}`,
      { stderrTail: `Invalid data in ${privatePath}\nAuthorization: Bearer ${secret}` },
    ));
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic).toMatchObject({ errorName: 'RenderError' });
    expect(serialized).toContain('Invalid data');
    expect(serialized).toContain('[redacted path]');
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain(secret);
  });

  it('preserves stable precondition codes without exposing scene identifiers', () => {
    expect(publicRenderFailure(new RenderError('Scene not found: private-scene'), 'scene')).toEqual({
      statusCode: 400,
      code: 'precondition_failed',
      error: 'Scene not found.',
    });
    expect(publicRenderFailure(new RenderError('Scene has no recording'), 'scene')).toEqual({
      statusCode: 400,
      code: 'precondition_failed',
      error: 'Scene has no recording.',
    });
  });

  it('preserves stable preview and thumbnail codes without raw tool output', () => {
    const error = new RenderError('ffmpeg failed for /private/project/video.mp4');
    expect(publicRenderFailure(error, 'transition-preview')).toEqual({
      statusCode: 500,
      code: 'preview_failed',
      error: 'Transition preview failed. Check the source media and try again.',
    });
    expect(publicRenderFailure(error, 'thumbnail')).toEqual({
      statusCode: 500,
      code: 'thumb_failed',
      error: 'Thumbnail rendering failed. Check the source media and try again.',
    });
  });
});
