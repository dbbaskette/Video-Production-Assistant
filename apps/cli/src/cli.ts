import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { VpaCliError, VpaHttpClient, type HttpClient } from './client.js';

type Expressiveness = 'light' | 'medium' | 'heavy';

interface Engine {
  id: string;
  displayName: string;
  ready: true;
  voices: Array<{ id: string; name: string; description?: string }>;
  supportedEmotives: string[];
  expressiveTags: string[];
  capabilities: {
    speed: { min: number; max: number; default: number };
    expressiveness: Expressiveness[];
    multiSpeaker: boolean;
    outputFormats: Array<'mp3' | 'wav'>;
    timings: 'estimated' | 'word' | 'none';
    subtitles: boolean;
    maxInputChars: number;
  };
}

interface Profile {
  id: string;
  name: string;
  engine: string;
  voice: string;
  speed: number;
  description?: string;
}

interface Job {
  id: string;
  type: string;
  status: string;
  error?: string;
  result?: unknown;
  [key: string]: unknown;
}

interface CliDependencies {
  client?: HttpClient;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readText?: (path: string) => Promise<string>;
  writeBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

type Options = Record<string, string | boolean>;

const HELP = `VPA command line

Usage:
  vpa narration engines list [--json]
  vpa narration voices list [--engine ID] [--json]
  vpa narration profiles list [--json]
  vpa narration options describe --engine ID [--json]
  vpa narration create (--text TEXT | --text-file PATH) (--profile ID | --engine ID --voice ID) [--speed N] [--expressiveness LEVEL] [--output PATH] [--json]
  vpa narration project PROJECT_ID (--profile ID | --engine ID --voice ID) [--speed N] [--expressiveness LEVEL] [--overwrite] [--wait] [--json]
  vpa projects list [--json]
  vpa projects show PROJECT_ID [--json]
  vpa production recipes list [--json]
  vpa production inspect PROJECT_ID RECIPE [--json]
  vpa production run PROJECT_ID RECIPE [--wait] [--interval-ms N] [--timeout-ms N] [--json]
  vpa jobs show JOB_ID [--json]
  vpa jobs wait JOB_ID [--interval-ms N] [--timeout-ms N] [--json]

Environment:
  VPA_API_URL  VPA API base URL (default: http://127.0.0.1:3000)
`;

const booleanOptions = new Set(['json', 'overwrite', 'wait', 'help']);

function invalid(message: string): never {
  throw new VpaCliError(message, 'invalid_request');
}

function parseArgs(argv: string[]): { positionals: string[]; options: Options } {
  const positionals: string[] = [];
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!key) invalid('Invalid empty option');
    if (key in options) invalid(`Option supplied more than once: --${key}`);
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) invalid(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { positionals, options };
}

function assertOptions(options: Options, allowed: string[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(options)) {
    if (!accepted.has(key)) invalid(`Unknown option: --${key}`);
  }
}

function textOption(options: Options, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function numberOption(options: Options, key: string, fallback?: number): number | undefined {
  const raw = textOption(options, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) invalid(`--${key} must be a number`);
  return value;
}

function expressivenessOption(options: Options): Expressiveness | undefined {
  const value = textOption(options, 'expressiveness');
  if (value === undefined) return undefined;
  if (value !== 'light' && value !== 'medium' && value !== 'heavy') {
    invalid('--expressiveness must be light, medium, or heavy');
  }
  return value;
}

function requireSelection(options: Options): { profile?: string; engine?: string; voice?: string } {
  const profile = textOption(options, 'profile');
  const engine = textOption(options, 'engine');
  const voice = textOption(options, 'voice');
  if (profile && (engine || voice)) invalid('Use --profile or --engine and --voice, not both');
  if (profile) return { profile };
  if (!engine || !voice) invalid('Supply --profile or both --engine and --voice');
  return { engine, voice };
}

function renderHuman(command: string, value: unknown): string {
  if (command === 'engines') {
    return (value as Engine[])
      .map((engine) => `${engine.id}\t${engine.displayName}\t${engine.voices.length} voices`)
      .join('\n');
  }
  if (command === 'voices') {
    return (value as Array<{ engine: string; id: string; name: string }>)
      .map((voice) => `${voice.engine}\t${voice.id}\t${voice.name}`)
      .join('\n');
  }
  if (command === 'profiles') {
    return (value as Profile[])
      .map(
        (profile) =>
          `${profile.id}\t${profile.name}\t${profile.engine}/${profile.voice}\t${profile.speed}x`,
      )
      .join('\n');
  }
  if (command === 'projects') {
    const projects =
      (
        value as {
          projects?: Array<{ id: string; name?: string; title?: string; missing?: boolean }>;
        }
      ).projects ?? [];
    return projects
      .map(
        (project) =>
          `${project.id}\t${project.name ?? project.title ?? ''}${project.missing ? '\tmissing' : ''}`,
      )
      .join('\n');
  }
  if (command === 'job') {
    const job = value as Job;
    return `${job.id}\t${job.status}${job.error ? `\t${job.error}` : ''}`;
  }
  if (command === 'created') {
    const clip = value as { id: string; engine: string; voice: string; output?: string };
    return `Created ${clip.id} with ${clip.engine}/${clip.voice}${clip.output ? `\nAudio: ${clip.output}` : ''}`;
  }
  if (command === 'started') {
    const result = value as { jobId: string; status: string };
    return `${result.jobId}\t${result.status}`;
  }
  return JSON.stringify(value, null, 2);
}

async function loadEngines(client: HttpClient): Promise<Engine[]> {
  return client.json<Engine[]>('GET', '/api/tts/engines');
}

async function loadProfiles(client: HttpClient): Promise<Profile[]> {
  return client.json<Profile[]>('GET', '/api/voices');
}

function validateEngineSelection(
  engines: Engine[],
  selection: { engine: string; voice: string; speed: number },
): void {
  const engine = engines.find((candidate) => candidate.id === selection.engine);
  if (!engine) invalid(`Narration engine is unavailable: ${selection.engine}`);
  if (!engine.voices.some((candidate) => candidate.id === selection.voice)) {
    invalid(`Voice ${selection.voice} is not available for ${selection.engine}`);
  }
  if (
    selection.speed < engine.capabilities.speed.min ||
    selection.speed > engine.capabilities.speed.max
  ) {
    invalid(
      `Speed for ${selection.engine} must be between ${engine.capabilities.speed.min} and ${engine.capabilities.speed.max}`,
    );
  }
}

async function resolveProjectSelection(client: HttpClient, options: Options) {
  const selected = requireSelection(options);
  let engine = selected.engine;
  let voice = selected.voice;
  let profile: Profile | undefined;
  if (selected.profile) {
    profile = (await loadProfiles(client)).find((candidate) => candidate.id === selected.profile);
    if (!profile) invalid(`Voice profile not found: ${selected.profile}`);
    engine = profile.engine;
    voice = profile.voice;
  }
  const engines = await loadEngines(client);
  const engineInfo = engines.find((candidate) => candidate.id === engine);
  if (!engineInfo || !engine || !voice) invalid('Narration selection could not be resolved');
  const speed = numberOption(
    options,
    'speed',
    profile?.speed ?? engineInfo.capabilities.speed.default,
  )!;
  const expressiveness = expressivenessOption(options);
  validateEngineSelection(engines, { engine, voice, speed });
  return { engine, voice, speed, expressiveness };
}

async function waitForJob(
  client: HttpClient,
  id: string,
  intervalMs: number,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<Job> {
  const started = Date.now();
  while (true) {
    const job = await client.json<Job>('GET', `/api/jobs/${encodeURIComponent(id)}`);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted')
      return job;
    if (Date.now() - started >= timeoutMs) {
      throw new VpaCliError(`Timed out waiting for job ${id}`, 'job_timeout');
    }
    await sleep(intervalMs);
  }
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const env = dependencies.env ?? process.env;
  const jsonMode = argv.includes('--json');
  const client =
    dependencies.client ?? new VpaHttpClient(env.VPA_API_URL ?? 'http://127.0.0.1:3000');
  const readText = dependencies.readText ?? ((path) => readFile(path, 'utf8'));
  const writeBytes =
    dependencies.writeBytes ??
    (async (path, bytes) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    });
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));

  const emit = (command: string, value: unknown) =>
    stdout(jsonMode ? JSON.stringify(value) : renderHuman(command, value));

  try {
    const { positionals, options } = parseArgs(argv);
    if (options.help || positionals.length === 0) {
      assertOptions(options, ['help', 'json']);
      stdout(HELP.trimEnd());
      return 0;
    }

    const command = positionals.join(' ');
    if (command === 'narration engines list') {
      assertOptions(options, ['json']);
      const engines = await loadEngines(client);
      emit('engines', engines);
      return 0;
    }
    if (command === 'narration voices list') {
      assertOptions(options, ['engine', 'json']);
      const filter = textOption(options, 'engine');
      const voices = (await loadEngines(client))
        .filter((engine) => !filter || engine.id === filter)
        .flatMap((engine) => engine.voices.map((voice) => ({ engine: engine.id, ...voice })));
      if (filter && voices.length === 0)
        invalid(`Narration engine is unavailable or has no voices: ${filter}`);
      emit('voices', voices);
      return 0;
    }
    if (command === 'narration profiles list') {
      assertOptions(options, ['json']);
      const profiles = await loadProfiles(client);
      emit('profiles', profiles);
      return 0;
    }
    if (command === 'narration options describe') {
      assertOptions(options, ['engine', 'json']);
      const id = textOption(options, 'engine');
      if (!id) invalid('--engine is required');
      const engine = (await loadEngines(client)).find((candidate) => candidate.id === id);
      if (!engine) invalid(`Narration engine is unavailable: ${id}`);
      emit('object', engine);
      return 0;
    }
    if (command === 'projects list') {
      assertOptions(options, ['json']);
      const projects = await client.json<unknown>('GET', '/api/projects');
      emit('projects', projects);
      return 0;
    }
    if (positionals[0] === 'projects' && positionals[1] === 'show' && positionals.length === 3) {
      assertOptions(options, ['json']);
      const project = await client.json<unknown>(
        'GET',
        `/api/projects/${encodeURIComponent(positionals[2]!)}`,
      );
      emit('object', project);
      return 0;
    }
    if (command === 'production recipes list') {
      assertOptions(options, ['json']);
      emit('object', await client.json('GET', '/api/production/recipes'));
      return 0;
    }
    if (positionals[0] === 'production' && positionals[1] === 'inspect' && positionals.length === 4) {
      assertOptions(options, ['json']);
      emit('object', await client.json('GET', `/api/projects/${encodeURIComponent(positionals[2]!)}/production/recipes/${encodeURIComponent(positionals[3]!)}/inspect`));
      return 0;
    }
    if (positionals[0] === 'production' && positionals[1] === 'run' && positionals.length === 4) {
      assertOptions(options, ['wait', 'interval-ms', 'timeout-ms', 'json']);
      const started = await client.json<{ jobId: string; status: string }>('POST', `/api/projects/${encodeURIComponent(positionals[2]!)}/production/recipes/${encodeURIComponent(positionals[3]!)}/run`, {});
      if (options.wait) {
        const intervalMs = numberOption(options, 'interval-ms', 1_000)!;
        const timeoutMs = numberOption(options, 'timeout-ms', 600_000)!;
        if (intervalMs < 1 || timeoutMs < 1) invalid('Wait intervals and timeouts must be positive');
        const job = await waitForJob(client, started.jobId, intervalMs, timeoutMs, sleep);
        emit('job', job);
        return job.status === 'completed' ? 0 : 1;
      }
      emit('started', started);
      return 0;
    }
    if (positionals[0] === 'narration' && positionals[1] === 'create' && positionals.length === 2) {
      assertOptions(options, [
        'text',
        'text-file',
        'profile',
        'engine',
        'voice',
        'speed',
        'expressiveness',
        'output',
        'json',
      ]);
      const inlineText = textOption(options, 'text');
      const textFile = textOption(options, 'text-file');
      if ((inlineText ? 1 : 0) + (textFile ? 1 : 0) !== 1)
        invalid('Supply exactly one of --text or --text-file');
      const text = inlineText ?? (await readText(textFile!));
      const selection = requireSelection(options);
      const response = await client.json<Record<string, unknown> & { audioUrl: string }>(
        'POST',
        '/api/tts/scratch',
        {
          text,
          ...selection,
          ...(numberOption(options, 'speed') === undefined
            ? {}
            : { speed: numberOption(options, 'speed') }),
          ...(expressivenessOption(options)
            ? { expressiveness: expressivenessOption(options) }
            : {}),
        },
      );
      const output = textOption(options, 'output');
      let result: Record<string, unknown> = response;
      if (output) {
        const absoluteOutput = resolve(output);
        const bytes = await client.bytes(response.audioUrl);
        if (bytes.length === 0)
          throw new VpaCliError('VPA returned an empty audio artifact', 'empty_audio');
        await writeBytes(absoluteOutput, bytes);
        result = { ...response, output: absoluteOutput };
      }
      emit('created', result);
      return 0;
    }
    if (
      positionals[0] === 'narration' &&
      positionals[1] === 'project' &&
      positionals.length === 3
    ) {
      assertOptions(options, [
        'profile',
        'engine',
        'voice',
        'speed',
        'expressiveness',
        'overwrite',
        'wait',
        'json',
      ]);
      const projectId = positionals[2]!;
      const selection = await resolveProjectSelection(client, options);
      const started = await client.json<{ jobId: string; status: string }>(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/narration/generate-project`,
        {
          engine: selection.engine,
          voice: selection.voice,
          speed: selection.speed,
          expressiveness: selection.expressiveness ?? 'medium',
          overwrite: options.overwrite === true,
        },
      );
      if (options.wait) {
        const job = await waitForJob(client, started.jobId, 1_000, 600_000, sleep);
        emit('job', job);
        return job.status === 'completed' ? 0 : 1;
      }
      emit('started', started);
      return 0;
    }
    if (positionals[0] === 'jobs' && positionals[1] === 'show' && positionals.length === 3) {
      assertOptions(options, ['json']);
      const job = await client.json<Job>('GET', `/api/jobs/${encodeURIComponent(positionals[2]!)}`);
      emit('job', job);
      return 0;
    }
    if (positionals[0] === 'jobs' && positionals[1] === 'wait' && positionals.length === 3) {
      assertOptions(options, ['interval-ms', 'timeout-ms', 'json']);
      const intervalMs = numberOption(options, 'interval-ms', 1_000)!;
      const timeoutMs = numberOption(options, 'timeout-ms', 600_000)!;
      if (intervalMs < 1 || timeoutMs < 1) invalid('Wait intervals and timeouts must be positive');
      const job = await waitForJob(client, positionals[2]!, intervalMs, timeoutMs, sleep);
      emit('job', job);
      return job.status === 'completed' ? 0 : 1;
    }

    invalid(`Unknown command: ${command}`);
  } catch (error) {
    const known =
      error instanceof VpaCliError
        ? error
        : new VpaCliError(
            error instanceof Error ? error.message : String(error),
            'unexpected_error',
          );
    const payload = {
      error: known.message,
      code: known.code,
      ...(known.status === undefined ? {} : { status: known.status }),
      ...(known.details === undefined ? {} : { details: known.details }),
    };
    stderr(jsonMode ? JSON.stringify(payload) : `Error [${known.code}]: ${known.message}`);
    return 1;
  }
}

export { HELP };
