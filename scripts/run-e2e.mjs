import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routingSpec = normalize('tests/e2e/model-routing.spec.ts');
const sharedConfig = 'tests/e2e/playwright.config.ts';
const routingConfig = 'tests/e2e/model-routing.playwright.config.ts';
const standaloneOptions = new Set([
  '--debug',
  '--fail-on-flaky-tests',
  '--forbid-only',
  '--headed',
  '--list',
  '--pass-with-no-tests',
  '--quiet',
  '--ui',
  '-x',
]);
const inlineValueOptions = new Set([
  '--grep',
  '--grep-invert',
  '--max-failures',
  '--output',
  '--project',
  '--repeat-each',
  '--reporter',
  '--retries',
  '--shard',
  '--timeout',
  '--trace',
  '--workers',
  '-g',
]);

function validateOption(arg) {
  if (
    arg === '--config' ||
    arg.startsWith('--config=') ||
    arg === '-c' ||
    arg.startsWith('-c=')
  ) {
    throw new Error(
      'Configuration overrides are not supported; the E2E runner owns harness selection.',
    );
  }

  if (standaloneOptions.has(arg)) return;

  const separator = arg.indexOf('=');
  const name = separator === -1 ? arg : arg.slice(0, separator);
  if (inlineValueOptions.has(name)) {
    if (separator !== -1 && arg.slice(separator + 1).length > 0) return;
    throw new Error(`Unsupported Playwright option ${arg}; pass its value inline as ${name}=VALUE.`);
  }

  throw new Error(`Unsupported Playwright option ${arg}; add it to the audited safe-option list.`);
}

export function selectE2eInvocation(args, availableSpecs) {
  for (const arg of args) {
    if (arg.startsWith('-')) validateOption(arg);
  }

  const available = new Set(availableSpecs.map((spec) => normalize(spec)));
  const requestedSpecs = args
    .filter((arg) => !arg.startsWith('-'))
    .map((arg) => normalize(arg));
  const unknownSpecs = requestedSpecs.filter((spec) => !available.has(spec));
  if (unknownSpecs.length > 0) {
    throw new Error(
      `Only exact repository-relative spec paths are supported; rejected: ${unknownSpecs.join(', ')}.`,
    );
  }

  const requestsRouting = requestedSpecs.includes(routingSpec);
  const requestsOther = requestedSpecs.some((spec) => spec !== routingSpec);

  if (requestsRouting && requestsOther) {
    throw new Error(
      'The model-routing spec uses an isolated fixture and must run separately from shared E2E specs.',
    );
  }

  if (requestsRouting) {
    return { config: routingConfig, args };
  }

  if (requestsOther) {
    return { config: sharedConfig, args };
  }

  const sharedSpecs = availableSpecs
    .filter((spec) => spec.endsWith('.spec.ts') && !normalize(spec).endsWith(routingSpec))
    .sort();
  return { config: sharedConfig, args: [...sharedSpecs, ...args] };
}

export function discoverSpecs(
  e2eDir = join(root, 'tests', 'e2e'),
  repositoryRoot = root,
) {
  const canonicalE2eDir = realpathSync(e2eDir);
  const identities = new Set();
  return readdirSync(e2eDir, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.spec.ts'))
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(`E2E spec entries must be regular files; rejected: ${entry.name}.`);
      }

      const specPath = join(e2eDir, entry.name);
      const stats = lstatSync(specPath, { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`E2E spec entries must be regular files; rejected: ${entry.name}.`);
      }

      const canonicalSpecPath = realpathSync(specPath);
      const canonicalRelative = relative(canonicalE2eDir, canonicalSpecPath);
      if (
        canonicalRelative === '..' ||
        canonicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(canonicalRelative)
      ) {
        throw new Error(`E2E spec files must remain inside the E2E directory: ${entry.name}.`);
      }

      const identity = stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`;
      if (stats.nlink !== 1n || (identity !== null && identities.has(identity))) {
        throw new Error(
          `E2E spec files must have unique filesystem identities; rejected: ${entry.name}.`,
        );
      }
      if (identity !== null) identities.add(identity);

      return relative(repositoryRoot, specPath).split(sep).join('/');
    });
}

function run() {
  let invocation;
  try {
    invocation = selectE2eInvocation(process.argv.slice(2), discoverSpecs());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  console.log(`[e2e] config: ${invocation.config}`);
  const executable = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  const result = spawnSync(
    executable,
    ['test', '--config', invocation.config, ...invocation.args],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
