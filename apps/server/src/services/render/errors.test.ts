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

  it('redacts a credential before bounding a diagnostic even when its value exceeds 5000 characters', () => {
    const leakedSuffix = 'SECRET_SUFFIX_SHOULD_NOT_LEAK';
    const longSecret = `${'x'.repeat(6_000)}${leakedSuffix}`;

    const diagnostic = privateRenderDiagnostic(new RenderError(
      `ffmpeg failed --token ${longSecret} after probing input`,
    ));
    const serialized = JSON.stringify(diagnostic);

    expect(serialized).toContain('--token [redacted secret]');
    expect(serialized).toContain('after probing input');
    expect(serialized).not.toContain(leakedSuffix);
    expect(serialized.length).toBeLessThan(2_500);
  });

  it('redacts quoted and media-like absolute Unix paths containing spaces without consuming prose', () => {
    const quotedPath = '/Users/alice/Private Project/source clip.mp4';
    const unquotedPath = '/private/tmp/Render Jobs/final output.mov';
    const ordinaryProse = 'Render failed / retry later and said "/ retry later", but keep this explanation.';

    const diagnostic = privateRenderDiagnostic(new RenderError(
      `Could not open "${quotedPath}" or ${unquotedPath}. ${ordinaryProse}`,
    ));
    const serialized = JSON.stringify(diagnostic);

    expect(serialized).not.toContain(quotedPath);
    expect(serialized).not.toContain(unquotedPath);
    expect(serialized).not.toContain('Private Project');
    expect(serialized).not.toContain('source clip.mp4');
    expect(serialized).not.toContain('Render Jobs');
    expect(serialized).not.toContain('final output.mov');
    expect(serialized.match(/\[redacted path\]/g)).toHaveLength(2);
    expect(diagnostic).toMatchObject({ message: expect.stringContaining(ordinaryProse) });
  });

  it('redacts unquoted spaced absolute paths independently of extension', () => {
    const paths = [
      '/Users/alice/Private Project/font.ttf',
      '/private/tmp/Review Documents/source deck.pdf',
      '/tmp/Render Jobs/extensionless output',
    ];
    const ordinaryProse = 'Render failed / retry later, but keep this explanation.';
    const diagnostic = privateRenderDiagnostic(new RenderError(
      `Inputs: ${paths[0]}; ${paths[1]}; ${paths[2]}\n${ordinaryProse}`,
    ));
    const serialized = JSON.stringify(diagnostic);

    for (const path of paths) {
      expect(serialized).not.toContain(path);
      expect(serialized).not.toContain(path.split('/').at(-1));
    }
    expect(serialized.match(/\[redacted path\]/g)).toHaveLength(3);
    expect(diagnostic).toMatchObject({ message: expect.stringContaining(ordinaryProse) });
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
