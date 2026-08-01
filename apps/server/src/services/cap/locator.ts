import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { CapProcessRequest, CapProcessResult, LocatedCap } from './types.js';

const MAX_DIAGNOSTIC_BYTES = 2_048;

interface PersistedCapSetup {
  cliPath?: string;
  version?: string;
  verifiedAt?: string;
  diagnostic?: string;
}

export interface CapLocatorOptions {
  vpaHome: string;
  run: (request: CapProcessRequest) => Promise<CapProcessResult>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  systemApplicationsDir?: string;
  now?: () => Date;
}

function boundDiagnostic(value: string): string {
  const bytes = Buffer.from(value);
  return bytes.subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8');
}

function parseVersion(stdout: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Cap version output was not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cap version output was not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.error === 'string') throw new Error(record.error);
  if (typeof record.version !== 'string' || !record.version.trim()) {
    throw new Error('Cap version output did not include a version');
  }
  return record.version.trim();
}

export class CapLocator {
  private readonly setupPath: string;
  private diagnostic = '';

  constructor(private readonly options: CapLocatorOptions) {
    this.setupPath = join(options.vpaHome, 'setup', 'cap.json');
  }

  getDiagnostic(): string {
    return this.diagnostic;
  }

  async locate(_force = false): Promise<LocatedCap | null> {
    const persisted = await this.readPersisted();
    const candidates = this.candidates(persisted.cliPath);
    const failures: string[] = [];

    for (const candidate of candidates) {
      let resolved: string;
      try {
        resolved = await realpath(candidate);
        const info = await stat(resolved);
        if (!info.isFile()) throw new Error('not a regular file');
        await access(resolved, constants.X_OK);
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      try {
        const response = await this.options.run({
          executable: resolved,
          args: ['version', '--json'],
          cwd: this.options.vpaHome,
          timeoutMs: 10_000,
        });
        if (response.exitCode !== 0) {
          throw new Error(response.stderr.trim() || `exit ${response.exitCode}`);
        }
        const version = parseVersion(response.stdout);
        const located = { cliPath: resolved, version };
        this.diagnostic = boundDiagnostic(`Verified Cap ${version} at ${resolved}`);
        await this.persist(located, this.diagnostic);
        return located;
      } catch (error) {
        failures.push(`${resolved}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.diagnostic = boundDiagnostic(failures.length > 0
      ? `No usable Cap CLI found. ${failures.join('; ')}`
      : 'No Cap CLI candidate was found.');
    return null;
  }

  private candidates(persistedPath?: string): string[] {
    const env = this.options.env ?? process.env;
    const pathCandidates = (env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry.length > 0 && isAbsolute(entry))
      .map((entry) => join(entry, 'cap'));
    const applicationRoot = this.options.systemApplicationsDir ?? '/Applications';
    const userHome = this.options.homeDir ?? homedir();
    const ordered = [
      persistedPath,
      join(this.options.vpaHome, 'bin', 'cap'),
      ...pathCandidates,
      join(applicationRoot, 'Cap.app', 'Contents', 'MacOS', 'cap-cli'),
      join(userHome, 'Applications', 'Cap.app', 'Contents', 'MacOS', 'cap-cli'),
    ].filter((value): value is string => Boolean(value));
    return [...new Set(ordered)];
  }

  private async readPersisted(): Promise<PersistedCapSetup> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.setupPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as PersistedCapSetup
        : {};
    } catch {
      return {};
    }
  }

  private async persist(located: LocatedCap, diagnostic: string): Promise<void> {
    await mkdir(join(this.options.vpaHome, 'setup'), { recursive: true });
    const state = {
      cliPath: located.cliPath,
      version: located.version,
      verifiedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      diagnostic: boundDiagnostic(diagnostic),
    };
    await writeFile(this.setupPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}
