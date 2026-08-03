import test from 'node:test';
import assert from 'node:assert/strict';
import { selectE2eInvocation } from './run-e2e.mjs';

const specs = [
  'tests/e2e/brand-creation.spec.ts',
  'tests/e2e/model-routing.spec.ts',
  'tests/e2e/script.spec.ts',
];

test('generic E2E keeps the shared config and excludes the routing-only spec', () => {
  assert.deepEqual(selectE2eInvocation([], specs), {
    config: 'tests/e2e/playwright.config.ts',
    args: ['tests/e2e/brand-creation.spec.ts', 'tests/e2e/script.spec.ts'],
  });
});

test('an existing explicit spec keeps the shared config', () => {
  assert.deepEqual(selectE2eInvocation(['tests/e2e/brand-creation.spec.ts'], specs), {
    config: 'tests/e2e/playwright.config.ts',
    args: ['tests/e2e/brand-creation.spec.ts'],
  });
});

test('the routing spec selects only its isolated config', () => {
  assert.deepEqual(selectE2eInvocation(['tests/e2e/model-routing.spec.ts'], specs), {
    config: 'tests/e2e/model-routing.playwright.config.ts',
    args: ['tests/e2e/model-routing.spec.ts'],
  });
});

test('mixed shared and routing specs fail closed', () => {
  assert.throws(
    () =>
      selectE2eInvocation(
        ['tests/e2e/brand-creation.spec.ts', 'tests/e2e/model-routing.spec.ts'],
        specs,
      ),
    /must run separately/,
  );
});
