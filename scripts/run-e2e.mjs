import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routingSpec = normalize('tests/e2e/model-routing.spec.ts');
const sharedConfig = 'tests/e2e/playwright.config.ts';
const routingConfig = 'tests/e2e/model-routing.playwright.config.ts';

export function selectE2eInvocation(args, availableSpecs) {
  const normalizedArgs = args.map((arg) => normalize(arg));
  const requestedSpecs = normalizedArgs.filter((arg) => arg.endsWith('.spec.ts'));
  const requestsRouting = requestedSpecs.some((arg) => arg.endsWith(routingSpec));
  const requestsOther = requestedSpecs.some((arg) => !arg.endsWith(routingSpec));

  if (requestsRouting && requestsOther) {
    throw new Error(
      'The model-routing spec uses an isolated fixture and must run separately from shared E2E specs.',
    );
  }

  if (requestsRouting) {
    return { config: routingConfig, args };
  }

  if (requestedSpecs.length > 0) {
    return { config: sharedConfig, args };
  }

  const sharedSpecs = availableSpecs
    .filter((spec) => spec.endsWith('.spec.ts') && !normalize(spec).endsWith(routingSpec))
    .sort();
  return { config: sharedConfig, args: [...sharedSpecs, ...args] };
}

function discoverSpecs() {
  const e2eDir = join(root, 'tests', 'e2e');
  return readdirSync(e2eDir)
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => relative(root, join(e2eDir, name)).split(sep).join('/'));
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
