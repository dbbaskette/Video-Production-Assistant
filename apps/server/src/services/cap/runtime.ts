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
  CapProcessRequest,
  CapStartInput,
  CapTarget,
  LocatedCap,
} from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

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

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
    await this.assertGuideSupports('doctor', '--json');
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
    await this.assertGuideSupports('targets', '--json');
    const value = await this.runJson(['targets', '--json'], 'Cap targets');
    const targets: CapTarget[] = [];
    for (const item of Array.isArray(value.screens) ? value.screens : []) {
      const screen = record(item, 'Cap screen target');
      targets.push({
        kind: 'screen',
        id: requiredString(String(screen.id ?? ''), 'screen target ID'),
        name: typeof screen.name === 'string' && screen.name ? screen.name : `Screen ${screen.id}`,
        width: numberOrUndefined(screen.width),
        height: numberOrUndefined(screen.height),
      });
    }
    for (const item of Array.isArray(value.windows) ? value.windows : []) {
      const window = record(item, 'Cap window target');
      targets.push({
        kind: 'window',
        id: requiredString(String(window.id ?? ''), 'window target ID'),
        name: typeof window.title === 'string' && window.title ? window.title : `Window ${window.id}`,
        application: typeof window.ownerName === 'string' ? window.ownerName : undefined,
        width: numberOrUndefined(window.width),
        height: numberOrUndefined(window.height),
      });
    }
    return targets;
  }

  async startRecording(input: CapStartInput): Promise<{ recordingId: string; projectPath: string }> {
    const flag = input.targetKind === 'window' ? '--window' : '--screen';
    await this.assertGuideSupports('record', 'start', flag, '--detach', '--json');
    const targetId = requiredString(input.targetId, 'capture target ID');
    const args = ['record', 'start', flag, targetId];
    if (input.fps !== undefined) {
      if (!Number.isInteger(input.fps) || input.fps <= 0 || input.fps > 120) throw new Error('Cap fps is invalid');
      args.push('--fps', String(input.fps));
    }
    if (input.projectPath) args.push('--path', input.projectPath);
    if (input.cameraId) args.push('--camera', input.cameraId);
    if (input.microphoneId) args.push('--mic', input.microphoneId);
    if (input.systemAudio) args.push('--system-audio');
    args.push('--detach', '--json');
    const events = await this.runEvents(args, 'Cap recording start');
    const started = [...events].reverse().find((event) => event.type === 'started');
    if (!started) throw new Error('Cap recording start did not return a started event');
    return {
      recordingId: requiredString(started.recordingId, 'recording ID'),
      projectPath: requiredString(started.path, 'recording project path'),
    };
  }

  async stopRecording(recordingId: string): Promise<{ recordingMetaExists: true; projectPath: string }> {
    await this.assertGuideSupports('record', 'stop', '--id', '--json');
    const exactId = requiredString(recordingId, 'recording ID');
    const events = await this.runEvents(['record', 'stop', '--id', exactId, '--json'], 'Cap recording stop');
    const stopped = [...events].reverse().find((event) => event.type === 'stopped');
    if (!stopped) throw new Error('Cap recording stop did not return a stopped event');
    if (stopped.recordingMetaExists !== true) throw new Error('Cap recording metadata was not finalized');
    return {
      recordingMetaExists: true,
      projectPath: requiredString(stopped.path, 'recording project path'),
    };
  }

  async validateProject(projectPath: string): Promise<void> {
    await this.assertGuideSupports('project', 'validate', '--json');
    const exactPath = requiredString(projectPath, 'project path');
    const value = await this.runJson(['project', 'validate', exactPath, '--json'], 'Cap project validation');
    if (value.valid !== true) throw new Error('Cap project is invalid');
  }

  async exportProject(projectPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    await this.assertGuideSupports('export', '--output', '--json');
    const exactProject = requiredString(projectPath, 'project path');
    const exactOutput = requiredString(outputPath, 'export output path');
    const events = await this.runEvents(
      ['export', exactProject, '--output', exactOutput, '--json'],
      'Cap export',
      signal,
    );
    const terminal = [...events].reverse().find((event) =>
      ['completed', 'exported', 'finished'].includes(String(event.type))
      && event.success !== false,
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
    if (force) this.guideCache = null;
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
    const response = await this.process.runJsonl({
      executable: located.cliPath,
      args,
      cwd: this.options.vpaHome,
      timeoutMs: args[0] === 'export' ? 30 * 60_000 : 60_000,
      signal,
    });
    for (const event of response.events) {
      if (typeof event.error === 'string') throw new Error(`${context} failed: ${event.error}`);
    }
    return response.events;
  }

  private async assertGuideSupports(...tokens: string[]): Promise<void> {
    const manifest = JSON.stringify(await this.guide()).toLowerCase();
    const missing = tokens.filter((token) => !manifest.includes(token.toLowerCase()));
    if (missing.length > 0) throw new Error(`Installed Cap guide does not support: ${missing.join(', ')}`);
  }

  private status(input: Omit<CapSetupStatus, 'updatedAt'>): CapSetupStatus {
    return CapSetupStatusSchema.parse({
      ...input,
      message: input.message ? Buffer.from(input.message).subarray(0, 2_048).toString('utf8') : undefined,
      updatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
  }
}
