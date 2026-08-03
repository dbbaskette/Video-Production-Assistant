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

test('multiple existing ordinary specs keep the shared config', () => {
  assert.deepEqual(
    selectE2eInvocation(
      ['tests/e2e/brand-creation.spec.ts', 'tests/e2e/script.spec.ts'],
      specs,
    ),
    {
      config: 'tests/e2e/playwright.config.ts',
      args: ['tests/e2e/brand-creation.spec.ts', 'tests/e2e/script.spec.ts'],
    },
  );
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

for (const selector of ['model-routing.spec.ts', 'model-routing', 'tests/e2e']) {
  test(`ambiguous selector ${selector} fails closed`, () => {
    assert.throws(
      () => selectE2eInvocation([selector], specs),
      /Only exact repository-relative spec paths are supported/,
    );
  });
}

for (const args of [
  ['--config=tests/e2e/model-routing.playwright.config.ts'],
  ['--config', 'tests/e2e/model-routing.playwright.config.ts'],
  ['-c', 'tests/e2e/model-routing.playwright.config.ts'],
  ['-c=tests/e2e/model-routing.playwright.config.ts'],
]) {
  test(`config override ${args[0]} fails closed`, () => {
    assert.throws(
      () => selectE2eInvocation(args, specs),
      /Configuration overrides are not supported/,
    );
  });
}

test('generic safe options remain pinned to ordinary specs', () => {
  assert.deepEqual(selectE2eInvocation(['--list', '--grep=model-routing'], specs), {
    config: 'tests/e2e/playwright.config.ts',
    args: [
      'tests/e2e/brand-creation.spec.ts',
      'tests/e2e/script.spec.ts',
      '--list',
      '--grep=model-routing',
    ],
  });
});

test('unknown options fail closed', () => {
  assert.throws(
    () => selectE2eInvocation(['--test-list=tmp/tests.txt'], specs),
    /Unsupported Playwright option/,
  );
});

test('separate option values fail closed instead of becoming selectors', () => {
  assert.throws(
    () => selectE2eInvocation(['--grep', 'model-routing'], specs),
    /Unsupported Playwright option.*inline/,
  );
});
