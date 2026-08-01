import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { CapSetupStatusSchema, type CapSetupStatus } from '@vpa/shared';
import { runJsonlProcess } from '../process/jsonl-process.js';
import { CapLocator } from './locator.js';
import type {
  CapDoctorResult,
  CapProcess,
  CapStartInput,
  CapTarget,
  LocatedCap,
} from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 2_048;

function noCapCredentials(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.CAP_API_KEY;
  delete clean.CAP_SERVER_URL;
  return clean;
}

export function createCapProcess(): CapProcess {
  return {
    async run(request) {
      try {
        const { stdout, stderr } = await execFileAsync(request.executable, request.args, {
          cwd: request.cwd,
          env: noCapCredentials(request.env),
          timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: request.signal,
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          encoding: 'utf8',
          shell: false,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
        if (failure.name === 'AbortError') throw failure;
        return {
          stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
          stderr: typeof failure.stderr === 'string' ? failure.stderr : failure.message,
          exitCode: typeof failure.code === 'number' ? failure.code : 1,
        };
      }
    },
    runJsonl(request) {
      return runJsonlProcess({
        executable: request.executable,
        args: request.args,
        cwd: request.cwd ?? dirname(request.executable),
        stdin: '',
        env: noCapCredentials(request.env),
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: request.signal,
        onEvent: request.onEvent,
      });
    },
  };
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} did not return a JSON object`);
  }
  const object = value as Record<string, unknown>;
  if (typeof object.error === 'string') throw new Error(`${context} failed: ${object.error}`);
  return object;
}

function parseJson(stdout: string, context: string): Record<string, unknown> {
  try {
    return record(JSON.parse(stdout), context);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${context} returned malformed JSON`);
    throw error;
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Cap ${label} was missing`);
  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Cap targets ${label} array was missing or invalid`);
  return value;
}

function targetId(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`Cap ${label} was invalid`);
}

function targetLabel(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Cap ${label} was invalid`);
  return value;
}

function targetDimension(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Cap ${label} was invalid`);
  }
  return value;
}

function boundedDiagnostic(value: string): string {
  const bytes = Buffer.from(value);
  return bytes.subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8');
}

function describeUnknown(value: unknown): string {
  if (typeof value === 'string') return value.trim() || 'unspecified error';
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function eventFailure(event: Record<string, unknown>): string | null {
  if (Object.prototype.hasOwnProperty.call(event, 'error')) {
    return boundedDiagnostic(describeUnknown(event.error));
  }
  const type = typeof event.type === 'string' ? event.type.toLowerCase() : '';
  const status = typeof event.status === 'string' ? event.status.toLowerCase() : '';
  if (['error', 'failed', 'failure'].includes(type)
    || ['error', 'failed', 'failure'].includes(status)
    || event.success === false) {
    const diagnostic = event.message ?? event.diagnostic ?? `Cap event reported ${type || status || 'failure'}`;
    return boundedDiagnostic(describeUnknown(diagnostic));
  }
  return null;
}

function flagsFromText(value: string): Set<string> {
  return new Set(value.match(/--[a-z0-9][a-z0-9-]*/gi) ?? []);
}

function flagsFromDeclaredList(value: unknown): Set<string> {
  if (!Array.isArray(value)) throw new Error('Cap guide command flags were not an array');
  const flags = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string') {
      for (const flag of flagsFromText(item)) flags.add(flag);
      continue;
    }
    const option = record(item, 'Cap guide command flag');
    const candidate = option.long ?? option.flag ?? option.name;
    if (typeof candidate !== 'string' || !candidate.startsWith('--')) {
      throw new Error('Cap guide command flag was invalid');
    }
    flags.add(candidate);
  }
  return flags;
}

interface GuideCommandCapabilities {
  flags: Set<string>;
  flagsAreAuthoritative: boolean;
}

export interface CapRuntimeOptions {
  vpaHome: string;
  locator: CapLocator;
  process?: CapProcess;
  now?: () => Date;
}

export interface CapRuntime {
  getStatus(force?: boolean): Promise<CapSetupStatus>;
  guide(): Promise<Record<string, unknown>>;
  doctor(): Promise<CapDoctorResult>;
  targets(): Promise<CapTarget[]>;
  startRecording(input: CapStartInput): Promise<{ recordingId: string; projectPath: string }>;
  stopRecording(recordingId: string): Promise<{ recordingMetaExists: true; projectPath: string }>;
  validateProject(projectPath: string): Promise<void>;
  exportProject(projectPath: string, outputPath: string, signal?: AbortSignal): Promise<void>;
}

export class ManagedCapRuntime implements CapRuntime {
  private readonly process: CapProcess;
  private located: LocatedCap | null = null;
  private guideCache: { version: string; guide: Record<string, unknown> } | null = null;
  private readonly helpFlags = new Map<string, Set<string>>();
  private installationStatus: CapSetupStatus | null = null;

  constructor(private readonly options: CapRuntimeOptions) {
    this.process = options.process ?? createCapProcess();
  }

  setInstallationStatus(status: CapSetupStatus): void {
    this.installationStatus = CapSetupStatusSchema.parse(status);
    if (status.state === 'ready') this.located = status.cliPath && status.version
      ? { cliPath: status.cliPath, version: status.version }
      : null;
  }

  async getStatus(force = false): Promise<CapSetupStatus> {
    if (this.installationStatus?.state === 'installing') return this.installationStatus;
    if (!force && this.installationStatus?.state === 'error') return this.installationStatus;

    const located = await this.locate(force);
    if (!located) {
      return this.status({
        state: 'not-installed', installed: false, captureReady: false,
        missingPermissions: [], targetCount: 0, message: this.options.locator.getDiagnostic(),
      });
    }

    try {
      const [doctor, targets] = await Promise.all([this.doctor(), this.targets()]);
      const value = this.status({
        state: doctor.captureReady ? 'ready' : 'needs-permission',
        installed: true,
        cliPath: located.cliPath,
        version: located.version,
        captureReady: doctor.captureReady,
        missingPermissions: doctor.missingPermissions,
        targetCount: targets.length,
      });
      this.installationStatus = null;
      return value;
    } catch (error) {
      return this.status({
        state: 'error', installed: true, cliPath: located.cliPath, version: located.version,
        captureReady: false, missingPermissions: [], targetCount: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async guide(): Promise<Record<string, unknown>> {
    const located = await this.requireLocated();
    if (this.guideCache?.version === located.version) return this.guideCache.guide;
    const guide = await this.runJson(['guide', '--json'], 'Cap guide');
    if (Object.keys(guide).length === 0) throw new Error('Cap guide was empty');
    this.guideCache = { version: located.version, guide };
    return guide;
  }

  async doctor(): Promise<CapDoctorResult> {
    await this.assertCommandSupports('doctor', ['--json']);
    const value = await this.runJson(['doctor', '--json'], 'Cap doctor');
    if (value.ok !== true) throw new Error('Cap doctor reported required checks failed');
    if (typeof value.captureReady !== 'boolean') {
      throw new Error('Cap doctor did not report capture readiness');
    }
    const permissions = record(value.permissions ?? {}, 'Cap doctor permissions');
    const screenStatus = permissions.screenRecording;
    const missingPermissions: CapDoctorResult['missingPermissions'] = [];
    if (value.captureReady === false || screenStatus === 'denied' || screenStatus === 'notDetermined') {
      missingPermissions.push('screen-recording');
    }
    return { captureReady: value.captureReady, missingPermissions };
  }

  async targets(): Promise<CapTarget[]> {
    await this.assertCommandSupports('targets', ['--json']);
    const value = await this.runJson(['targets', '--json'], 'Cap targets');
    const targets: CapTarget[] = [];
    for (const item of requiredArray(value.screens, 'screens')) {
      const screen = record(item, 'Cap screen target');
      targets.push({
        kind: 'screen',
        id: targetId(screen.id, 'screen target ID'),
        name: targetLabel(screen.name, 'screen target name'),
        width: targetDimension(screen.width, 'screen target width'),
        height: targetDimension(screen.height, 'screen target height'),
      });
    }
    for (const item of requiredArray(value.windows, 'windows')) {
      const window = record(item, 'Cap window target');
      targets.push({
        kind: 'window',
        id: targetId(window.id, 'window target ID'),
        name: targetLabel(window.title, 'window target title'),
        application: targetLabel(window.ownerName, 'window target application'),
        width: targetDimension(window.width, 'window target width'),
        height: targetDimension(window.height, 'window target height'),
      });
    }
    return targets;
  }

  async startRecording(input: CapStartInput): Promise<{ recordingId: string; projectPath: string }> {
    const flag = input.targetKind === 'window' ? '--window' : '--screen';
    const targetId = requiredString(input.targetId, 'capture target ID');
    const args = ['record', 'start', flag, targetId];
    const selectedFlags = [flag];
    if (input.fps !== undefined) {
      if (!Number.isInteger(input.fps) || input.fps <= 0 || input.fps > 120) throw new Error('Cap fps is invalid');
      args.push('--fps', String(input.fps));
      selectedFlags.push('--fps');
    }
    if (input.projectPath) {
      args.push('--path', input.projectPath);
      selectedFlags.push('--path');
    }
    if (input.cameraId) {
      args.push('--camera', input.cameraId);
      selectedFlags.push('--camera');
    }
    if (input.microphoneId) {
      args.push('--mic', input.microphoneId);
      selectedFlags.push('--mic');
    }
    if (input.systemAudio) {
      args.push('--system-audio');
      selectedFlags.push('--system-audio');
    }
    args.push('--detach', '--json');
    selectedFlags.push('--detach', '--json');
    await this.assertCommandSupports('record start', selectedFlags);
    const events = await this.runEvents(args, 'Cap recording start');
    const started = [...events].reverse().find((event) => String(event.type).toLowerCase() === 'started');
    if (!started) throw new Error('Cap recording start did not return a started event');
    return {
      recordingId: requiredString(started.recordingId, 'recording ID'),
      projectPath: requiredString(started.path, 'recording project path'),
    };
  }

  async stopRecording(recordingId: string): Promise<{ recordingMetaExists: true; projectPath: string }> {
    await this.assertCommandSupports('record stop', ['--id', '--json']);
    const exactId = requiredString(recordingId, 'recording ID');
    const events = await this.runEvents(['record', 'stop', '--id', exactId, '--json'], 'Cap recording stop');
    const stopped = [...events].reverse().find((event) => String(event.type).toLowerCase() === 'stopped');
    if (!stopped) throw new Error('Cap recording stop did not return a stopped event');
    if (stopped.recordingId !== undefined) {
      const returnedId = requiredString(stopped.recordingId, 'stopped recording ID');
      if (returnedId !== exactId) throw new Error('Cap stopped recording ID did not match the requested recording ID');
    }
    if (stopped.recordingMetaExists !== true) throw new Error('Cap recording metadata was not finalized');
    return {
      recordingMetaExists: true,
      projectPath: requiredString(stopped.path, 'recording project path'),
    };
  }

  async validateProject(projectPath: string): Promise<void> {
    await this.assertCommandSupports('project validate', ['--json']);
    const exactPath = requiredString(projectPath, 'project path');
    const value = await this.runJson(['project', 'validate', exactPath, '--json'], 'Cap project validation');
    if (value.valid !== true) throw new Error('Cap project is invalid');
  }

  async exportProject(projectPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    await this.assertCommandSupports('export', ['--output', '--json']);
    const exactProject = requiredString(projectPath, 'project path');
    const exactOutput = requiredString(outputPath, 'export output path');
    const events = await this.runEvents(
      ['export', exactProject, '--output', exactOutput, '--json'],
      'Cap export',
      signal,
    );
    const terminal = [...events].reverse().find((event) =>
      ['completed', 'exported', 'finished'].includes(String(event.type).toLowerCase()),
    );
    if (!terminal) throw new Error('Cap export did not report terminal success');
    if (typeof terminal.path === 'string' && terminal.path !== exactOutput) {
      throw new Error('Cap export returned an unexpected output path');
    }
    const info = await stat(exactOutput).catch(() => null);
    if (!info?.isFile()) throw new Error('Cap export MP4 does not exist');
    if (info.size <= 0) throw new Error('Cap export MP4 is empty');
  }

  private async locate(force = false): Promise<LocatedCap | null> {
    if (!force && this.located) return this.located;
    this.located = await this.options.locator.locate(force);
    if (force) {
      this.guideCache = null;
      this.helpFlags.clear();
    }
    return this.located;
  }

  private async requireLocated(): Promise<LocatedCap> {
    const located = await this.locate();
    if (!located) throw new Error(this.options.locator.getDiagnostic() || 'Cap CLI is not installed');
    return located;
  }

  private async runJson(args: string[], context: string): Promise<Record<string, unknown>> {
    const located = await this.requireLocated();
    const response = await this.process.run({
      executable: located.cliPath,
      args,
      cwd: this.options.vpaHome,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (response.exitCode !== 0) throw new Error(`${context} failed: ${response.stderr.trim() || `exit ${response.exitCode}`}`);
    return parseJson(response.stdout, context);
  }

  private async runEvents(
    args: string[],
    context: string,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const located = await this.requireLocated();
    let streamedFailure: string | null = null;
    const response = await this.process.runJsonl({
      executable: located.cliPath,
      args,
      cwd: this.options.vpaHome,
      timeoutMs: args[0] === 'export' ? 30 * 60_000 : 60_000,
      signal,
      onEvent: (event) => {
        streamedFailure ??= eventFailure(event);
      },
    });
    for (const event of response.events) streamedFailure ??= eventFailure(event);
    if (streamedFailure) throw new Error(`${context} failed: ${streamedFailure}`);
    return response.events;
  }

  private async assertCommandSupports(command: string, selectedFlags: string[]): Promise<void> {
    const capabilities = await this.guideCommandCapabilities(command);
    let missing = selectedFlags.filter((flag) => !capabilities.flags.has(flag));
    if (missing.length > 0 && !capabilities.flagsAreAuthoritative) {
      const help = await this.commandHelpFlags(command);
      missing = missing.filter((flag) => !help.has(flag));
    }
    if (missing.length > 0) {
      throw new Error(`Installed Cap command ${command} does not support ${missing.join(', ')}`);
    }
  }

  private async guideCommandCapabilities(command: string): Promise<GuideCommandCapabilities> {
    const manifest = await this.guide();
    if (!Array.isArray(manifest.commands)) throw new Error('Cap guide commands were missing');
    const normalizedCommand = command.trim().replace(/\s+/g, ' ');
    let matched: Record<string, unknown> | undefined;
    for (const item of manifest.commands) {
      const entry = record(item, 'Cap guide command');
      if (typeof entry.command !== 'string') throw new Error('Cap guide command name was missing');
      if (entry.command.trim().replace(/\s+/g, ' ') === normalizedCommand) matched = entry;
    }
    if (!matched) throw new Error(`Installed Cap guide does not advertise command ${command}`);

    const globalFlags = new Set<string>();
    if (manifest.outputConvention && typeof manifest.outputConvention === 'object') {
      const outputConvention = record(manifest.outputConvention, 'Cap guide output convention');
      if (typeof outputConvention.jsonFlag === 'string') {
        for (const flag of flagsFromText(outputConvention.jsonFlag)) globalFlags.add(flag);
      }
    }

    const declared = matched.flags ?? matched.options;
    if (declared !== undefined) {
      const flags = flagsFromDeclaredList(declared);
      for (const flag of globalFlags) flags.add(flag);
      return { flags, flagsAreAuthoritative: true };
    }

    const flags = flagsFromText(JSON.stringify(matched));
    for (const flag of globalFlags) flags.add(flag);
    return { flags, flagsAreAuthoritative: false };
  }

  private async commandHelpFlags(command: string): Promise<Set<string>> {
    const located = await this.requireLocated();
    const cacheKey = `${located.version}:${command}`;
    const cached = this.helpFlags.get(cacheKey);
    if (cached) return cached;
    const response = await this.process.run({
      executable: located.cliPath,
      args: [...command.split(' '), '--help'],
      cwd: this.options.vpaHome,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (response.exitCode !== 0) {
      throw new Error(`Could not inspect Cap command ${command}: ${response.stderr.trim() || `exit ${response.exitCode}`}`);
    }
    const flags = flagsFromText(`${response.stdout}\n${response.stderr}`);
    this.helpFlags.set(cacheKey, flags);
    return flags;
  }

  private status(input: Omit<CapSetupStatus, 'updatedAt'>): CapSetupStatus {
    return CapSetupStatusSchema.parse({
      ...input,
      message: input.message ? Buffer.from(input.message).subarray(0, 2_048).toString('utf8') : undefined,
      updatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
  }
}
