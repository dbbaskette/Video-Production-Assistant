/**
 * Qwen3-TTS provider (local, via mlx_audio).
 *
 * Runs a local Python subprocess: `python3 -m mlx_audio.tts.generate`
 * targeting the `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16` model — the
 * same backend the Voicebox.app uses successfully on this machine.
 *
 * Qwen3-TTS Base uses ICL (in-context-learning) cloning that internally
 * floors `repetition_penalty` at 1.5 to prevent code degeneration on long
 * reference prefills, which avoids the loop/stutter failure modes that
 * plague some other MLX TTS conversions.
 *
 * Capabilities:
 *   • Zero-shot voice cloning via --ref_audio + --ref_text
 *   • Native 24 kHz mono output (matches our canonical transcode format)
 *   • Respects temperature, top_p, top_k, repetition_penalty, max_tokens
 *
 * No API key needed — fully local.
 *
 * Environment variables:
 *   QWEN_TTS_MODEL              – model path or HF id
 *                                 (default: mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16)
 *   QWEN_TTS_TEMPERATURE        – sampling temperature (default: 0.9)
 *   QWEN_TTS_TOP_P              – nucleus sampling (default: 1.0)
 *   QWEN_TTS_TOP_K              – top-k sampling (default: 50)
 *   QWEN_TTS_REPETITION_PENALTY – rep penalty; auto-floors at 1.5 for ICL (default: 1.05)
 *   QWEN_TTS_MAX_TOKENS         – per-segment token budget (default: 4096)
 *   QWEN_TTS_LANG_CODE          – language hint (default: en)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, mkdir, rm } from 'node:fs/promises';
import type { TtsProvider, TtsResult, TtsGenerateOpts } from '../provider.js';

const execFileAsync = promisify(execFile);

/**
 * Resolve the python3 binary to use.
 * Prefer the project's .venv if it exists, else fall back to system python3.
 */
function resolvePython(): string {
  const wsRoot = resolve(import.meta.dirname, '../../../../../..');
  const venvPython = join(wsRoot, '.venv', 'bin', 'python3');
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}

const DEFAULT_MODEL = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';

interface QwenConfig {
  modelPath: string;
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  maxTokens: number;
  langCode: string;
}

function loadConfig(): QwenConfig {
  return {
    modelPath: process.env.QWEN_TTS_MODEL || DEFAULT_MODEL,
    temperature: parseFloat(process.env.QWEN_TTS_TEMPERATURE || '0.9'),
    topP: parseFloat(process.env.QWEN_TTS_TOP_P || '1.0'),
    topK: parseInt(process.env.QWEN_TTS_TOP_K || '50', 10),
    repetitionPenalty: parseFloat(process.env.QWEN_TTS_REPETITION_PENALTY || '1.05'),
    maxTokens: parseInt(process.env.QWEN_TTS_MAX_TOKENS || '4096', 10),
    langCode: process.env.QWEN_TTS_LANG_CODE || 'en',
  };
}

export function createQwenTtsProvider(): TtsProvider {
  const config = loadConfig();

  return {
    id: 'qwen',
    displayName: 'Qwen3-TTS (local) — voice cloning',
    // Qwen3-TTS Base doesn't have a documented inline-tag taxonomy, so
    // leave the supported set empty — the script gate won't whitelist
    // emotive tags that the model would just speak literally.
    supportedEmotives: new Set<string>(),
    expressiveTags: [],
    voices: [
      {
        id: 'default',
        name: 'Default voice',
        description: 'Qwen3-TTS without cloning — pick a clone:<id> for your own voice',
      },
    ],

    async generate(script: string, opts: TtsGenerateOpts): Promise<TtsResult> {
      const voiceId = opts.voice ?? 'default';
      const speed = opts.speed ?? 1.0;

      // Resolve reference audio + text for clone:<slug> voices. Layout matches
      // the existing voice-clone store at ~/.vpa/voice-clones/<slug>/.
      let refAudio: string | undefined;
      let refText: string | undefined;
      if (voiceId.startsWith('clone:')) {
        const slug = voiceId.slice('clone:'.length);
        const home = process.env.HOME ?? '';
        const wav = `${home}/.vpa/voice-clones/${slug}/audio.wav`;
        const txt = `${home}/.vpa/voice-clones/${slug}/transcript.txt`;
        if (!existsSync(wav)) {
          throw new Error(`Voice clone audio not found: ${wav}`);
        }
        refAudio = wav;
        try {
          const t = readFileSync(txt, 'utf-8').trim();
          if (t) refText = t;
        } catch { /* transcript missing — Qwen handles ICL without it less well, but still works */ }
      }

      const tmpDir = join(tmpdir(), `vpa-qwen-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });

      try {
        const args = [
          '-m', 'mlx_audio.tts.generate',
          '--model', config.modelPath,
          '--text', script,
          '--output_path', tmpDir,
          '--audio_format', 'wav',
          '--lang_code', config.langCode,
          '--temperature', String(config.temperature),
          '--top_p', String(config.topP),
          '--top_k', String(config.topK),
          '--repetition_penalty', String(config.repetitionPenalty),
          '--max_tokens', String(config.maxTokens),
        ];
        if (speed !== 1.0) args.push('--speed', String(speed));
        if (refAudio) {
          args.push('--ref_audio', refAudio);
          if (refText) args.push('--ref_text', refText);
        }

        const pythonBin = resolvePython();
        await execFileAsync(pythonBin, args, {
          cwd: tmpDir,
          timeout: 180_000,
          maxBuffer: 50 * 1024 * 1024,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error
          ? (err as Error & { stderr?: string }).stderr || err.message
          : String(err);
        throw new Error(`Qwen3-TTS failed: ${msg.slice(0, 500)}`);
      }

      const outputPath = join(tmpDir, 'audio_000.wav');
      if (!existsSync(outputPath)) {
        await rm(tmpDir, { recursive: true, force: true });
        throw new Error('Qwen3-TTS produced no output file');
      }

      const audio = await readFile(outputPath);
      await rm(tmpDir, { recursive: true, force: true });

      const durationSec = parseWavDuration(audio);
      const cleanText = script.replace(/\[[\w\s-]+\]/g, '').trim();
      const words = cleanText.split(/\s+/).filter((w) => w.length > 0);
      const timings = words.map((word, i) => ({
        word,
        t: words.length > 0 ? Math.round((i * durationSec / words.length) * 100) / 100 : 0,
      }));

      return {
        audio,
        timings,
        durationSec: Math.round(durationSec * 100) / 100,
      };
    },
  };
}

/** Parse duration from a WAV buffer's RIFF header. */
function parseWavDuration(buf: Buffer): number {
  if (buf.length < 44) return 1;
  const riff = buf.toString('ascii', 0, 4);
  const wave = buf.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') return 1;

  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (!sampleRate || !bitsPerSample || !numChannels) return 1;

  const bytesPerSample = (bitsPerSample / 8) * numChannels;

  let offset = 36;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return Math.max(0.1, chunkSize / (sampleRate * bytesPerSample));
    }
    offset += 8 + chunkSize;
  }

  return Math.max(0.1, (buf.length - 44) / (sampleRate * bytesPerSample));
}
