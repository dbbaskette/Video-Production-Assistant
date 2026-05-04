/**
 * Setup health probes — check that the dependencies VPA needs are present and
 * working. Surfaced via GET /api/setup/health and shown in the /setup UI.
 *
 * Each probe returns `{ status, message, fixHint }`. Status is `ok` (green),
 * `warn` (yellow — non-blocking, things still work), or `fail` (red — feature
 * disabled or broken).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TtsService } from '../tts/index.js';
import type { LlmClient } from '../llm/index.js';

const execFileAsync = promisify(execFile);

export type ProbeStatus = 'ok' | 'warn' | 'fail';

export interface ProbeResult {
  id: string;
  label: string;
  status: ProbeStatus;
  message: string;
  fixHint?: string;
  /** When this probe ran (ms since epoch). */
  ranAt: number;
}

export interface SetupHealth {
  probes: ProbeResult[];
  /** True when no probe failed. Warns are still considered acceptable. */
  allOk: boolean;
  /** True when no probe failed AND no probe warned. */
  allClean: boolean;
}

interface Deps {
  tts: TtsService;
  llm: LlmClient;
  vpaHome: string;
}

/** Run a child process with a hard timeout; resolves to stdout or rejects. */
async function runWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
}

const ok = (id: string, label: string, message: string): ProbeResult => ({
  id, label, status: 'ok', message, ranAt: Date.now(),
});
const warn = (id: string, label: string, message: string, fixHint?: string): ProbeResult => ({
  id, label, status: 'warn', message, fixHint, ranAt: Date.now(),
});
const fail = (id: string, label: string, message: string, fixHint?: string): ProbeResult => ({
  id, label, status: 'fail', message, fixHint, ranAt: Date.now(),
});

// ── Individual probes ────────────────────────────────────────────────

async function probeFfmpegPresent(): Promise<ProbeResult> {
  try {
    const { stdout } = await runWithTimeout('ffmpeg', ['-version'], 3000);
    const versionLine = stdout.split('\n')[0] ?? 'ffmpeg present';
    return ok('ffmpeg-present', 'ffmpeg', versionLine.slice(0, 80));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail('ffmpeg-present', 'ffmpeg', `Not found on PATH: ${msg.slice(0, 100)}`,
      'Install ffmpeg via Homebrew: brew install homebrew-ffmpeg/ffmpeg/ffmpeg');
  }
}

async function probeFfmpegDrawtext(): Promise<ProbeResult> {
  try {
    const { stdout } = await runWithTimeout('ffmpeg', ['-filters'], 5000);
    // ffmpeg -filters output rows look like: " T. drawtext          V->V       Draw text..."
    // Flags column is 1-3 chars (\S+), separated from the name by whitespace.
    const hasDrawtext = /(?:^|\n)\s*\S+\s+drawtext\b/m.test(stdout);
    if (hasDrawtext) {
      return ok('ffmpeg-drawtext', 'ffmpeg drawtext filter', 'Available — lower thirds will render');
    }
    return fail('ffmpeg-drawtext', 'ffmpeg drawtext filter',
      'Filter not in this build — lower thirds rendering will fail',
      'Reinstall ffmpeg with freetype: brew install homebrew-ffmpeg/ffmpeg/ffmpeg');
  } catch (err) {
    return fail('ffmpeg-drawtext', 'ffmpeg drawtext filter',
      `Could not list filters: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function probeFfprobe(): Promise<ProbeResult> {
  try {
    const { stdout } = await runWithTimeout('ffprobe', ['-version'], 3000);
    const versionLine = stdout.split('\n')[0] ?? 'ffprobe present';
    return ok('ffprobe-present', 'ffprobe', versionLine.slice(0, 80));
  } catch (err) {
    return fail('ffprobe-present', 'ffprobe',
      `Not found on PATH: ${err instanceof Error ? err.message : String(err)}`,
      'ffprobe ships with ffmpeg — installing ffmpeg should provide it');
  }
}

async function probeLlm(llm: LlmClient): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      llm.complete({
        systemPrompt: 'Reply with the single word OK and nothing else.',
        userPrompt: 'Reply with OK.',
        responseFormat: 'text',
        temperature: 0,
        maxTokens: 20,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM ping timed out after 8s')), 8000),
      ),
    ]);
    const elapsed = Date.now() - start;
    const text = (result?.text ?? '').trim().slice(0, 60);
    return ok('llm-connectivity', 'LLM connectivity', `Responded in ${elapsed}ms: "${text}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let hint: string | undefined;
    if (/401|403|unauthor/i.test(msg)) {
      hint = 'Check your VPA_LLM_PROVIDER and the corresponding API key in .env';
    } else if (/timeout|timed out/i.test(msg)) {
      hint = 'Provider is slow or unreachable — try a different VPA_LLM_PROVIDER';
    }
    return fail('llm-connectivity', 'LLM connectivity', msg.slice(0, 200), hint);
  }
}

function probeTtsProviders(tts: TtsService): ProbeResult {
  const engines = tts.listEngines().map((e) => e.id);
  const wanted: Array<{ id: string; envVar: string; note?: string }> = [
    { id: 'gemini', envVar: 'GEMINI_API_KEY' },
    { id: 'xai', envVar: 'XAI_API_KEY' },
    { id: 'fish', envVar: 'FISH_AUDIO_MODEL', note: 'and mlx_audio Python module' },
  ];
  const present = wanted.filter((w) => engines.includes(w.id)).map((w) => w.id);
  const missing = wanted.filter((w) => !engines.includes(w.id));

  if (present.length === wanted.length) {
    return ok('tts-providers', 'TTS providers',
      `All registered: ${present.join(', ')}${engines.includes('fake') ? ' + fake' : ''}`);
  }
  if (present.length === 0) {
    return warn('tts-providers', 'TTS providers',
      `Only the fake provider is registered. Set ${missing.map((m) => m.envVar).join(' or ')} to enable real TTS.`);
  }
  return warn('tts-providers', 'TTS providers',
    `${present.length} of ${wanted.length} real providers registered (${present.join(', ')}). Missing: ${missing.map((m) => m.id).join(', ')}.`,
    `Set ${missing.map((m) => m.envVar).join(' / ')} in .env to enable the missing providers`);
}

function probeXaiKey(): ProbeResult {
  const key = process.env.XAI_API_KEY;
  if (key && key.length > 0) {
    return ok('xai-api-key', 'XAI_API_KEY', 'Set — xAI TTS and custom voices are available');
  }
  return warn('xai-api-key', 'XAI_API_KEY',
    'Not set — xAI TTS and custom voice cloning are disabled',
    'Add XAI_API_KEY to .env (Enterprise plan needed for custom-voice creation)');
}

function probeXaiTeamId(): ProbeResult {
  const id = process.env.XAI_TEAM_ID;
  if (id && id.length > 0) {
    return ok('xai-team-id', 'XAI_TEAM_ID',
      `Set — "Clone via xAI console →" links to your team library`);
  }
  return warn('xai-team-id', 'XAI_TEAM_ID',
    'Not set — console-clone link will use a generic xAI URL',
    'Find your team id at https://console.x.ai/ and set XAI_TEAM_ID in .env');
}

async function probeFishAudio(): Promise<ProbeResult> {
  const modelPath = process.env.FISH_AUDIO_MODEL
    || `${process.env.HOME ?? ''}/.lmstudio/models/mlx-community/fish-audio-s2-pro-bf16`;
  if (!existsSync(modelPath)) {
    return warn('fish-audio', 'Fish Audio (local TTS)',
      `Model directory not found: ${modelPath}`,
      'Set FISH_AUDIO_MODEL to your model path, or download the model into the default location');
  }

  // mlx_audio import check via subprocess
  try {
    await runWithTimeout(
      'python3',
      ['-c', 'import mlx_audio'],
      5000,
    );
    return ok('fish-audio', 'Fish Audio (local TTS)', `Ready (model: ${modelPath})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return warn('fish-audio', 'Fish Audio (local TTS)',
      `Model present but mlx_audio Python module is not importable: ${msg.slice(0, 100)}`,
      'Run scripts/setup-python.sh to install mlx-audio in .venv');
  }
}

async function probeVpaHome(vpaHome: string): Promise<ProbeResult> {
  const probeFile = join(vpaHome, '.write-test');
  try {
    await mkdir(vpaHome, { recursive: true });
    await writeFile(probeFile, String(Date.now()));
    await access(probeFile);
    await rm(probeFile, { force: true });
    return ok('vpa-home', 'VPA_HOME directory', `Writable: ${vpaHome}`);
  } catch (err) {
    return fail('vpa-home', 'VPA_HOME directory',
      `Could not write under ${vpaHome}: ${err instanceof Error ? err.message : String(err)}`,
      'Check permissions on VPA_HOME, or set VPA_HOME to a different path in .env');
  }
}

// ── Top-level orchestrator + cache ───────────────────────────────────

/** Cache entry — kept here so re-mounting the route doesn't bust it. */
let cached: { result: SetupHealth; expiresAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function runSetupHealth(deps: Deps, opts: { force?: boolean } = {}): Promise<SetupHealth> {
  if (!opts.force && cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const probes = await Promise.all([
    probeFfmpegPresent(),
    probeFfmpegDrawtext(),
    probeFfprobe(),
    probeLlm(deps.llm),
    Promise.resolve(probeTtsProviders(deps.tts)),
    Promise.resolve(probeXaiKey()),
    Promise.resolve(probeXaiTeamId()),
    probeFishAudio(),
    probeVpaHome(deps.vpaHome),
  ]);

  const allOk = probes.every((p) => p.status !== 'fail');
  const allClean = probes.every((p) => p.status === 'ok');
  const result: SetupHealth = { probes, allOk, allClean };
  cached = { result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}

/** Reset the in-memory cache. Mainly for tests. */
export function clearSetupHealthCache(): void {
  cached = null;
}
