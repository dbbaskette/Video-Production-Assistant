import { error as consoleError, log as consoleLog } from 'node:console';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routingSpec = normalize('tests/e2e/model-routing.spec.ts');
const presentationSpec = normalize('tests/e2e/presentation-import.spec.ts');
const sharedConfig = 'tests/e2e/playwright.config.ts';
const routingConfig = 'tests/e2e/model-routing.playwright.config.ts';
const presentationConfig = 'tests/e2e/presentation-import.playwright.config.ts';
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
  const requestsPresentation = requestedSpecs.includes(presentationSpec);
  const requestsOther = requestedSpecs.some((spec) => (
    spec !== routingSpec && spec !== presentationSpec
  ));

  if (requestsRouting && (requestsOther || requestsPresentation)) {
    throw new Error(
      'The model-routing spec uses an isolated fixture and must run separately from shared E2E specs.',
    );
  }

  if (requestsPresentation && requestsOther) {
    throw new Error(
      'The presentation-import spec uses an isolated fixture and must run separately from shared E2E specs.',
    );
  }

  if (requestsRouting) {
    return { config: routingConfig, args };
  }

  if (requestsPresentation) {
    return { config: presentationConfig, args };
  }

  if (requestsOther) {
    return { config: sharedConfig, args };
  }

  const sharedSpecs = availableSpecs
    .filter((spec) => (
      spec.endsWith('.spec.ts')
      && normalize(spec) !== routingSpec
      && normalize(spec) !== presentationSpec
    ))
    .sort();
  return { config: sharedConfig, args: [...sharedSpecs, ...args] };
}

export function discoverSpecs(
  e2eDir = join(root, 'tests', 'e2e'),
  repositoryRoot = root,
) {
  const boundaryError = () =>
    new Error('E2E directory must be the real in-repository tests/e2e directory.');
  let canonicalRepositoryRoot;
  let canonicalE2eDir;
  let e2eDirStats;
  let expectedE2eDirStats;
  try {
    canonicalRepositoryRoot = realpathSync(repositoryRoot);
    e2eDirStats = lstatSync(e2eDir);
    canonicalE2eDir = realpathSync(e2eDir);
    expectedE2eDirStats = lstatSync(join(canonicalRepositoryRoot, 'tests', 'e2e'));
  } catch {
    throw boundaryError();
  }
  const expectedCanonicalE2eDir = join(canonicalRepositoryRoot, 'tests', 'e2e');
  if (
    !e2eDirStats.isDirectory() ||
    e2eDirStats.isSymbolicLink() ||
    !expectedE2eDirStats.isDirectory() ||
    expectedE2eDirStats.isSymbolicLink() ||
    canonicalE2eDir !== expectedCanonicalE2eDir
  ) {
    throw boundaryError();
  }

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

async function allocateLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate an isolated E2E port.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

export async function createPresentationE2eHarness(options = {}) {
  const temporaryDirectory = options.temporaryDirectory ?? await realpath(tmpdir());
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const temporaryInfo = await lstat(temporaryDirectory);
  const canonicalTemporaryDirectory = await realpath(temporaryDirectory);
  if (!temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink()) {
    throw new Error('Presentation E2E temporary directory must be a real directory.');
  }
  const root = await mkdtemp(join(canonicalTemporaryDirectory, 'vpa-presentation-e2e-'));
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root || dirname(root) !== canonicalTemporaryDirectory) {
    throw new Error('Presentation E2E root was not created canonically.');
  }
  try {
    const vpaHome = join(root, 'home');
    const projectsDefault = join(root, 'projects');
    await Promise.all([
      mkdir(vpaHome, { mode: 0o700 }),
      mkdir(projectsDefault, { mode: 0o700 }),
    ]);

    const apiPort = await allocatePort();
    let webPort = await allocatePort();
    for (let attempt = 0; webPort === apiPort && attempt < 8; attempt += 1) {
      webPort = await allocatePort();
    }
    if (
      !Number.isInteger(apiPort)
      || !Number.isInteger(webPort)
      || apiPort < 1
      || webPort < 1
      || apiPort > 65535
      || webPort > 65535
      || apiPort === webPort
    ) {
      throw new Error('Presentation E2E ports must be distinct valid ports.');
    }

    return {
      temporaryDirectory: canonicalTemporaryDirectory,
      root,
      vpaHome,
      projectsDefault,
      apiPort,
      webPort,
      env: {
        VPA_PRESENTATION_E2E_ROOT: root,
        VPA_PRESENTATION_E2E_HOME: vpaHome,
        VPA_PRESENTATION_E2E_PROJECTS: projectsDefault,
        VPA_PRESENTATION_E2E_API_PORT: String(apiPort),
        VPA_PRESENTATION_E2E_WEB_PORT: String(webPort),
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function removePresentationE2eHarness(harness) {
  const canonicalTemporaryDirectory = await realpath(harness.temporaryDirectory);
  if (
    dirname(harness.root) !== canonicalTemporaryDirectory
    || !basename(harness.root).startsWith('vpa-presentation-e2e-')
  ) {
    throw new Error('Refusing to remove an unowned presentation E2E root.');
  }
  let rootInfo;
  try {
    rootInfo = await lstat(harness.root);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Refusing to remove a replaced presentation E2E root.');
  }
  if (await realpath(harness.root) !== harness.root) {
    throw new Error('Refusing to remove a noncanonical presentation E2E root.');
  }
  await rm(harness.root, { recursive: true, force: true });
}

async function run() {
  let invocation;
  try {
    invocation = selectE2eInvocation(process.argv.slice(2), discoverSpecs());
  } catch (error) {
    consoleError(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  consoleLog(`[e2e] config: ${invocation.config}`);
  const executable = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  const harness = invocation.config === presentationConfig
    ? await createPresentationE2eHarness()
    : null;
  let result;
  try {
    result = spawnSync(
      executable,
      ['test', '--config', invocation.config, ...invocation.args],
      {
        cwd: root,
        env: harness ? { ...process.env, ...harness.env } : process.env,
        stdio: 'inherit',
      },
    );
  } finally {
    if (harness) await removePresentationE2eHarness(harness);
  }

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run().catch((error) => {
    consoleError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
