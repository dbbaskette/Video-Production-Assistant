import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapSetupStatusSchema, type CapSetupStatus } from '@vpa/shared';
import type { CapLocator } from './locator.js';
import type { CapProcessRequest, CapProcessResult, LocatedCap } from './types.js';
import { createCapProcess } from './runtime.js';

export const OFFICIAL_CAP_INSTALLER_URL = 'https://cap.so/install-cli.sh';
const MAX_DIAGNOSTIC_BYTES = 2_048;

type InstallerState = Pick<CapSetupStatus, 'state' | 'installed' | 'captureReady' | 'missingPermissions' | 'targetCount' | 'updatedAt'>
  & Partial<Pick<CapSetupStatus, 'installationId' | 'cliPath' | 'version' | 'message'>>;

export class CapInstallerError extends Error {
  constructor(public readonly code: 'CONFIRMATION_REQUIRED' | 'INSTALL_IN_PROGRESS', message: string) {
    super(message);
  }
}

export interface CapInstallerOptions {
  vpaHome: string;
  locator?: CapLocator;
  downloader?: (url: string, destination: string) => Promise<void>;
  runInstaller?: (request: CapProcessRequest) => Promise<CapProcessResult>;
  verify?: () => Promise<LocatedCap | null>;
  onState?: (status: CapSetupStatus) => void;
  now?: () => Date;
}

function bounded(value: string): string {
  return Buffer.from(value).subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8');
}

function installerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CAP_')) env[key] = value;
  }
  return env;
}

async function download(url: string, destination: string): Promise<void> {
  if (url !== OFFICIAL_CAP_INSTALLER_URL) throw new Error('Refusing an unapproved Cap installer URL');
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`Cap installer download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes, { mode: 0o700, flag: 'wx' });
}

export class CapInstaller {
  private job: Promise<void> | null = null;

  constructor(private readonly options: CapInstallerOptions) {}

  async start(input: { confirmed: true }): Promise<{ installationId: string; state: 'installing' }> {
    if (input.confirmed !== true) {
      throw new CapInstallerError('CONFIRMATION_REQUIRED', 'Cap installation requires explicit confirmation');
    }
    if (this.job) throw new CapInstallerError('INSTALL_IN_PROGRESS', 'Cap installation is already in progress');

    const installationId = randomUUID();
    this.publish({ state: 'installing', installed: false, captureReady: false, missingPermissions: [], targetCount: 0, installationId });
    this.job = this.install(installationId).finally(() => { this.job = null; });
    return { installationId, state: 'installing' };
  }

  async waitForIdle(): Promise<void> {
    await this.job;
  }

  private async install(installationId: string): Promise<void> {
    let directory: string | undefined;
    let response: CapProcessResult | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'cap-install-'));
      const scriptPath = join(directory, 'install-cli.sh');
      await (this.options.downloader ?? download)(OFFICIAL_CAP_INSTALLER_URL, scriptPath);
      const process = createCapProcess();
      response = await (this.options.runInstaller ?? process.run)({
        executable: '/bin/sh',
        args: [scriptPath],
        cwd: directory,
        env: {
          ...installerEnvironment(),
          CAP_CLI_INSTALL_DIR: join(this.options.vpaHome, 'bin'),
          CAP_NO_MODIFY_PATH: '1',
        },
        timeoutMs: 10 * 60_000,
      });
      const verify = this.options.verify ?? (() => this.options.locator?.locate(true) ?? Promise.resolve(null));
      const located = await verify();
      if (response.exitCode !== 0) throw new Error(response.stderr.trim() || `installer exited ${response.exitCode}`);
      if (!located) throw new Error('Cap installer finished but no verified CLI was found');
      this.publish({
        state: 'ready', installed: true, cliPath: located.cliPath, version: located.version,
        captureReady: false, missingPermissions: [], targetCount: 0, installationId,
        message: bounded(response.stdout.trim() || `Cap ${located.version} installed`),
      });
    } catch (error) {
      // Verification is intentionally attempted even after an installer failure.
      if (!response) {
        await (this.options.verify ?? (() => this.options.locator?.locate(true) ?? Promise.resolve(null)))().catch(() => null);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.publish({
        state: 'error', installed: false, captureReady: false, missingPermissions: [], targetCount: 0,
        installationId, message: bounded(message),
      });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  private publish(input: Omit<InstallerState, 'updatedAt'>): void {
    this.options.onState?.(CapSetupStatusSchema.parse({
      ...input,
      updatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    }));
  }
}
