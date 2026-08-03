import { describe, expect, it } from 'vitest';
import { safeSceneDiagnosticFields } from './safe-diagnostics.js';

describe('safeSceneDiagnosticFields', () => {
  it('retains an ordinary bounded scene identifier', () => {
    expect(safeSceneDiagnosticFields('scene-01')).toEqual({ sceneId: 'scene-01' });
  });

  it.each([
    '../private/scene',
    'https://provider.invalid/scene',
    'scene\nAuthorization: Bearer private',
    'secret-token-value',
    `scene-${'x'.repeat(121)}`,
  ])('omits unsafe or secret-like identifier %j', (sceneId) => {
    const fields = safeSceneDiagnosticFields(sceneId);
    expect(fields).toEqual({});
    expect(JSON.stringify(fields)).not.toContain(sceneId);
  });
});
