import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  TanzuBrandSetupStatusSchema,
  type TanzuBrandSetupStatus,
} from '@vpa/shared';
import { createCapProcess } from '../cap/runtime.js';
import type { CapProcessRequest, CapProcessResult } from '../cap/types.js';
import type { BrandPaths } from './paths.js';
import { syncTanzuBrand, type TanzuBrandSyncResult } from './tanzu-brand-source.js';

export const TANZU_BRAND_REPOSITORY = 'dbbaskette/tanzu-brand';
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_RELEASE_BYTES = 64 * 1024 * 1024;
const MAX_RELEASE_FILES = 500;
const MAX_DIAGNOSTIC_BYTES = 2_048;
const ACCESS_MESSAGE = `Install GitHub CLI (gh) and sign in to an account with access to ${TANZU_BRAND_REPOSITORY}, then try again.`;

type InstallerState = Omit<TanzuBrandSetupStatus, 'updatedAt'>;

interface StableRelease {
  tag: string;
  version: string;
  archiveName: string;
  checksumName: string;
}

export class TanzuBrandInstallerError extends Error {
  constructor(public readonly code: 'CONFIRMATION_REQUIRED' | 'INSTALL_IN_PROGRESS', message: string) {
    super(message);
  }
}

export interface TanzuBrandInstallerOptions {
  paths: BrandPaths;
  registryFile: string;
  run?: (request: CapProcessRequest) => Promise<CapProcessResult>;
  synchronize?: () => Promise<TanzuBrandSyncResult>;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

function bounded(value: string): string {
  return Buffer.from(value).subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8');
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
    'XDG_CONFIG_HOME', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
  return env;
}

function parseStableRelease(stdout: string): StableRelease {
  let release: unknown;
  try {
    release = JSON.parse(stdout);
  } catch {
    throw new Error('GitHub returned malformed Tanzu Brand release metadata. Nothing was installed.');
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('GitHub did not return a valid Tanzu Brand release. Nothing was installed.');
  }
  const value = release as Record<string, unknown>;
  const tag = typeof value.tagName === 'string' ? value.tagName : '';
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  if (!VERSION_PATTERN.test(version) || value.isDraft || value.isPrerelease || !Array.isArray(value.assets)) {
    throw new Error('The repository did not return a valid stable Tanzu Brand release. Nothing was installed.');
  }
  const archiveName = `tanzu-brand-${version}-mac.zip`;
  const checksumName = `${archiveName}.sha256`;
  const names = new Set(value.assets.flatMap((asset) => (
    asset && typeof asset === 'object' && typeof (asset as Record<string, unknown>).name === 'string'
      ? [(asset as Record<string, unknown>).name as string]
      : []
  )));
  if (!names.has(archiveName) || !names.has(checksumName)) {
    throw new Error('The latest Tanzu Brand release is missing its Mac installer or checksum. Nothing was installed.');
  }
  return { tag, version, archiveName, checksumName };
}

function safeReleasePath(name: string): boolean {
  return !!name
    && !name.includes('\\')
    && !name.startsWith('/')
    && !name.includes('\0')
    && name.split('/').every((part) => !!part && part !== '.' && part !== '..' && !part.includes(':'));
}

/** Extracts only the package payload from Tanzu Brand's deterministic, stored Mac ZIP. */
export async function extractVerifiedMacRelease(
  archivePath: string,
  targetRoot: string,
  expectedSha256: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('The Tanzu Brand release checksum is invalid. Nothing was installed.');
  const archive = await readFile(archivePath);
  if (archive.length > MAX_RELEASE_BYTES) throw new Error('The Tanzu Brand release is larger than VPA supports. Nothing was installed.');
  if (createHash('sha256').update(archive).digest('hex') !== expectedSha256) {
    throw new Error('The Tanzu Brand download did not match its release checksum. Nothing was installed.');
  }

  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const size = archive.readUInt32LE(offset + 18);
    const plainSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const end = offset + 30 + nameLength + extraLength + size;
    if (flags !== 0x800 || method !== 0 || size !== plainSize || extraLength !== 0 || end > archive.length) {
      throw new Error('The Tanzu Brand release ZIP is unsupported or corrupt. Nothing was installed.');
    }
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (!safeReleasePath(name) || files.has(name) || files.size >= MAX_RELEASE_FILES) {
      throw new Error('The Tanzu Brand release ZIP contains an unsafe file layout. Nothing was installed.');
    }
    files.set(name, archive.subarray(offset + 30 + nameLength, end));
    offset = end;
  }
  if (offset + 4 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
    throw new Error('The Tanzu Brand release ZIP directory is invalid. Nothing was installed.');
  }

  const required = [
    'tanzu-brand/package.json',
    'tanzu-brand/release.json',
    'tanzu-brand/SKILL.md',
    'tanzu-brand/scripts/install-mac.mjs',
  ];
  if (required.some((name) => !files.has(name))
    || [...files.keys()].some((name) => !name.startsWith('tanzu-brand/') && ![
      'Install-Tanzu-Brand.command', 'Install-Tanzu-Brand.sh', 'START HERE.txt',
    ].includes(name))) {
    throw new Error('The Tanzu Brand Mac release layout is invalid. Nothing was installed.');
  }

  await mkdir(targetRoot, { recursive: false });
  for (const [name, bytes] of files) {
    if (!name.startsWith('tanzu-brand/')) continue;
    const relative = name.slice('tanzu-brand/'.length);
    const destination = join(targetRoot, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
  }
}

export class TanzuBrandInstaller {
  private job: Promise<void> | null = null;
  private state: TanzuBrandSetupStatus | null = null;

  constructor(private readonly options: TanzuBrandInstallerOptions) {}

  async getStatus(force = false): Promise<TanzuBrandSetupStatus> {
    if (this.state?.state === 'installing') return this.state;
    const result = await this.synchronize().catch((error) => ({
      status: 'unavailable' as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (result.status !== 'unavailable') {
      return this.publish({
        state: 'ready',
        installed: true,
        sourceRoot: result.root,
        brandVersion: result.brandVersion,
        packageVersion: result.packageVersion,
        message: 'Tanzu Brand is installed, verified, and connected to VPA.',
      });
    }
    if ('error' in result) {
      return this.publish({ state: 'error', installed: false, message: bounded(`The installed Tanzu Brand package could not be verified: ${result.error}`) });
    }
    if (!force && this.state?.state === 'error') return this.state;
    return this.publish({
      state: 'not-installed',
      installed: false,
      message: 'Tanzu Brand is not installed. VPA can download the latest verified release after you confirm.',
    });
  }

  async start(input: { confirmed: true }): Promise<{ installationId: string; state: 'installing' }> {
    if (input.confirmed !== true) {
      throw new TanzuBrandInstallerError('CONFIRMATION_REQUIRED', 'Tanzu Brand installation requires explicit confirmation');
    }
    if (this.job) throw new TanzuBrandInstallerError('INSTALL_IN_PROGRESS', 'Tanzu Brand installation is already in progress');
    const installationId = randomUUID();
    this.publish({
      state: 'installing',
      installed: false,
      installationId,
      message: 'Downloading and verifying the latest Tanzu Brand release…',
    });
    this.job = this.install(installationId).finally(() => { this.job = null; });
    return { installationId, state: 'installing' };
  }

  async waitForIdle(): Promise<void> {
    await this.job;
  }

  private synchronize(): Promise<TanzuBrandSyncResult> {
    return this.options.synchronize?.()
      ?? syncTanzuBrand(this.options.paths, this.options.registryFile);
  }

  private async install(installationId: string): Promise<void> {
    let temporaryRoot: string | undefined;
    try {
      if ((this.options.platform ?? process.platform) !== 'darwin') {
        throw new Error('Automatic Tanzu Brand installation is currently available on macOS only. Set TANZU_BRAND_PATH to a verified package on this system.');
      }
      const run = this.options.run ?? createCapProcess().run;
      const releaseResponse = await run({
        executable: 'gh',
        args: ['release', 'view', '--repo', TANZU_BRAND_REPOSITORY, '--json', 'tagName,assets,isDraft,isPrerelease'],
        env: commandEnvironment(),
        timeoutMs: 20_000,
      });
      if (releaseResponse.exitCode !== 0) throw new Error(ACCESS_MESSAGE);
      const release = parseStableRelease(releaseResponse.stdout);
      temporaryRoot = await mkdtemp(join(tmpdir(), 'vpa-tanzu-brand-install-'));
      const downloadResponse = await run({
        executable: 'gh',
        args: [
          'release', 'download', release.tag,
          '--repo', TANZU_BRAND_REPOSITORY,
          '--dir', temporaryRoot,
          '--pattern', release.archiveName,
          '--pattern', release.checksumName,
        ],
        env: commandEnvironment(),
        timeoutMs: 120_000,
      });
      if (downloadResponse.exitCode !== 0) {
        throw new Error(`Could not download the private Tanzu Brand release. ${ACCESS_MESSAGE}`);
      }

      const checksumText = (await readFile(join(temporaryRoot, release.checksumName), 'utf8')).trim();
      const checksum = /^([0-9a-f]{64})  (tanzu-brand-[0-9]+\.[0-9]+\.[0-9]+-mac\.zip)$/.exec(checksumText);
      if (!checksum || checksum[2] !== release.archiveName) {
        throw new Error('The Tanzu Brand release checksum file is invalid. Nothing was installed.');
      }
      const sourceRoot = join(temporaryRoot, 'verified');
      await extractVerifiedMacRelease(join(temporaryRoot, release.archiveName), sourceRoot, checksum[1]!);

      const installResponse = await run({
        executable: process.execPath,
        args: [join(sourceRoot, 'scripts', 'install-mac.mjs'), '--yes', '--replace', '--google-slides', 'skip'],
        cwd: sourceRoot,
        env: commandEnvironment(),
        timeoutMs: 10 * 60_000,
      });
      if (installResponse.exitCode !== 0) {
        throw new Error(installResponse.stderr.trim() || `Tanzu Brand installer exited ${installResponse.exitCode}`);
      }
      const synced = await this.synchronize();
      if (synced.status === 'unavailable' || !synced.root) {
        throw new Error('Tanzu Brand setup finished, but VPA could not verify the installed package.');
      }
      this.publish({
        state: 'ready',
        installed: true,
        sourceRoot: synced.root,
        brandVersion: synced.brandVersion,
        packageVersion: synced.packageVersion,
        installationId,
        message: `Tanzu Brand ${synced.packageVersion ?? release.version} is installed, verified, and connected to VPA.`,
      });
    } catch (error) {
      this.publish({
        state: 'error',
        installed: false,
        installationId,
        message: bounded(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private publish(input: InstallerState): TanzuBrandSetupStatus {
    this.state = TanzuBrandSetupStatusSchema.parse({
      ...input,
      updatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
    return this.state;
  }
}
