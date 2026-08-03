import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSpecs, selectE2eInvocation } from './run-e2e.mjs';

const specs = [
  'tests/e2e/brand-creation.spec.ts',
  'tests/e2e/model-routing.spec.ts',
  'tests/e2e/script.spec.ts',
];

async function withTemporaryE2eDirectory(run) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'vpa-e2e-discovery-'));
  const repositoryRoot = join(workspaceRoot, 'repository');
  const e2eDir = join(repositoryRoot, 'tests', 'e2e');
  await mkdir(e2eDir, { recursive: true });
  try {
    await run({ workspaceRoot, repositoryRoot, e2eDir });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

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

test('regular discovered specs retain isolated and shared classification', async () => {
  await withTemporaryE2eDirectory(async ({ repositoryRoot, e2eDir }) => {
    await Promise.all([
      writeFile(join(e2eDir, 'model-routing.spec.ts'), 'routing\n'),
      writeFile(join(e2eDir, 'brand-creation.spec.ts'), 'ordinary\n'),
    ]);

    const discovered = discoverSpecs(e2eDir, repositoryRoot).sort();
    assert.deepEqual(discovered, [
      'tests/e2e/brand-creation.spec.ts',
      'tests/e2e/model-routing.spec.ts',
    ]);
    assert.equal(
      selectE2eInvocation(['tests/e2e/model-routing.spec.ts'], discovered).config,
      'tests/e2e/model-routing.playwright.config.ts',
    );
    assert.equal(
      selectE2eInvocation(['tests/e2e/brand-creation.spec.ts'], discovered).config,
      'tests/e2e/playwright.config.ts',
    );
    assert.deepEqual(selectE2eInvocation([], discovered).args, [
      'tests/e2e/brand-creation.spec.ts',
    ]);
  });
});

test('symlink spec aliases fail closed during discovery', async () => {
  await withTemporaryE2eDirectory(async ({ repositoryRoot, e2eDir }) => {
    await writeFile(join(e2eDir, 'model-routing.spec.ts'), 'routing\n');
    await symlink('model-routing.spec.ts', join(e2eDir, 'routing-alias.spec.ts'));

    assert.throws(
      () => discoverSpecs(e2eDir, repositoryRoot),
      /E2E spec entries must be regular files/,
    );
  });
});

test('hard-link spec aliases fail closed during discovery when supported', async (t) => {
  await withTemporaryE2eDirectory(async ({ repositoryRoot, e2eDir }) => {
    const routingPath = join(e2eDir, 'model-routing.spec.ts');
    await writeFile(routingPath, 'routing\n');
    try {
      await link(routingPath, join(e2eDir, 'routing-alias.spec.ts'));
    } catch (error) {
      if (['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        t.skip(`hard links unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => discoverSpecs(e2eDir, repositoryRoot),
      /E2E spec files must have unique filesystem identities/,
    );
  });
});

test('an external E2E directory fails canonical repository containment', async () => {
  await withTemporaryE2eDirectory(async ({ workspaceRoot, repositoryRoot }) => {
    const externalE2eDir = join(workspaceRoot, 'external-e2e');
    await mkdir(externalE2eDir);
    await writeFile(join(externalE2eDir, 'model-routing.spec.ts'), 'routing\n');

    assert.throws(
      () => discoverSpecs(externalE2eDir, repositoryRoot),
      /E2E directory must be the real in-repository tests\/e2e directory/,
    );
  });
});

test('a symlinked in-repository E2E directory to an external sibling fails closed', async () => {
  await withTemporaryE2eDirectory(async ({ workspaceRoot, repositoryRoot, e2eDir }) => {
    const externalE2eDir = join(workspaceRoot, 'external-e2e');
    await mkdir(externalE2eDir);
    await writeFile(join(externalE2eDir, 'model-routing.spec.ts'), 'routing\n');
    await rm(e2eDir, { recursive: true });
    await symlink(externalE2eDir, e2eDir, 'dir');

    assert.throws(
      () => discoverSpecs(e2eDir, repositoryRoot),
      /E2E directory must be the real in-repository tests\/e2e directory/,
    );
  });
});

test('a symlinked repository-root prefix remains safe when E2E is the expected real directory', async () => {
  await withTemporaryE2eDirectory(async ({ workspaceRoot, repositoryRoot, e2eDir }) => {
    await writeFile(join(e2eDir, 'brand-creation.spec.ts'), 'ordinary\n');
    const repositoryAlias = join(workspaceRoot, 'repository-alias');
    await symlink(repositoryRoot, repositoryAlias, 'dir');

    assert.deepEqual(
      discoverSpecs(join(repositoryAlias, 'tests', 'e2e'), repositoryAlias),
      ['tests/e2e/brand-creation.spec.ts'],
    );
  });
});
