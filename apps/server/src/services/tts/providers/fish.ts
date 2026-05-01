/**
 * Fish Audio TTS provider (local, via mlx_audio).
 *
 * Runs a local Python subprocess: `python3 -m mlx_audio.tts.generate`
 * using models stored in LM Studio's standard location:
 *   ~/.lmstudio/models/mlx-community/fish-audio-s2-pro-bf16
 *
 * No API key needed — this is a fully local provider.
 *
 * Environment variables:
 *   FISH_AUDIO_MODEL         – model path (default: ~/.lmstudio/models/mlx-community/fish-audio-s2-pro-bf16)
 *   FISH_AUDIO_STYLE         – inline style tag (default: professional broadcast tone)
 *   FISH_AUDIO_SPEED         – speed multiplier (default: 1.0)
 *   FISH_AUDIO_EXAGGERATION  – expression exaggeration (default: 0.3)
 *   FISH_AUDIO_TEMPERATURE   – sampling temperature (default: 0.7)
 *   FISH_AUDIO_REF_AUDIO     – path to reference WAV for voice cloning
 *   FISH_AUDIO_REF_TEXT      – transcript of the reference audio
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, mkdir, rm } from 'node:fs/promises';
import type { TtsProvider, TtsResult, TtsGenerateOpts } from '../provider.js';

const execFileAsync = promisify(execFile);

/**
 * Resolve the python3 binary to use.
 * Prefer the project's .venv if it exists, else fall back to system python3.
 */
function resolvePython(): string {
  // Walk up from this file to find the workspace root (.venv lives there)
  const wsRoot = resolve(import.meta.dirname, '../../../../../..');
  const venvPython = join(wsRoot, '.venv', 'bin', 'python3');
  if (existsSync(venvPython)) return venvPython;
  return 'python3'; // fallback
}

/** Strip emotive tags like [warm], [confident] from text. */
function stripEmotiveTags(text: string): string {
  return text.replace(/\[[\w-]+\]\s*/g, '').trim();
}

/** Expand ~ to home directory. */
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/** Wrap raw PCM samples (16-bit LE, mono) in a RIFF/WAVE container. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm.copy(wav, headerSize);

  return wav;
}

const DEFAULT_MODEL = '~/.lmstudio/models/mlx-community/fish-audio-s2-pro-bf16';

export interface FishAudioConfig {
  modelPath: string;
  style: string;
  speed: number;
  exaggeration: number;
  temperature: number;
  refAudio?: string;
  refText?: string;
}

function loadFishConfig(): FishAudioConfig {
  return {
    modelPath: expandTilde(process.env.FISH_AUDIO_MODEL || DEFAULT_MODEL),
    style: process.env.FISH_AUDIO_STYLE || 'professional broadcast tone',
    speed: parseFloat(process.env.FISH_AUDIO_SPEED || '1.0'),
    exaggeration: parseFloat(process.env.FISH_AUDIO_EXAGGERATION || '0.3'),
    temperature: parseFloat(process.env.FISH_AUDIO_TEMPERATURE || '0.7'),
    refAudio: process.env.FISH_AUDIO_REF_AUDIO
      ? expandTilde(process.env.FISH_AUDIO_REF_AUDIO)
      : undefined,
    refText: process.env.FISH_AUDIO_REF_TEXT || undefined,
  };
}

export function createFishTtsProvider(): TtsProvider {
  const config = loadFishConfig();

  return {
    id: 'fish-audio',
    displayName: 'Fish Audio (local)',
    supportedEmotives: new Set([
      'warm', 'confident', 'calm', 'excited', 'serious', 'friendly',
      'professional', 'enthusiastic',
    ]),
    // Fish Audio uses voice cloning, not a fixed voice catalog.
    // We expose a single "default" voice that uses the configured style + reference audio.
    voices: [
      {
        id: 'default',
        name: 'Default',
        description: config.refAudio
          ? `Voice clone from reference audio (style: ${config.style})`
          : `Style: ${config.style}`,
      },
    ],

    async generate(script: string, opts: TtsGenerateOpts): Promise<TtsResult> {
      const cleanText = stripEmotiveTags(script);
      const speed = opts.speed ?? config.speed;

      // Prepend style tag to text (Fish Audio uses inline tags)
      const styledText = `[${config.style}] ${cleanText}`;

      // Create temp output directory
      const tmpDir = join(tmpdir(), `vpa-fish-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });

      try {
        // Build CLI args
        const args = [
          '-m', 'mlx_audio.tts.generate',
          '--model', config.modelPath,
          '--text', styledText,
          '--output_path', tmpDir,
        ];

        if (speed !== 1.0) args.push('--speed', String(speed));
        if (config.exaggeration) args.push('--exaggeration', String(config.exaggeration));
        if (config.temperature) args.push('--temperature', String(config.temperature));

        // Voice cloning via reference audio
        if (config.refAudio) {
          args.push('--ref_audio', config.refAudio);
          if (config.refText) {
            args.push('--ref_text', config.refText);
          }
        }

        // Additional optional env vars
        const voice = process.env.FISH_AUDIO_VOICE;
        if (voice) args.push('--voice', voice);
        const instruct = process.env.FISH_AUDIO_INSTRUCT;
        if (instruct) args.push('--instruct', instruct);
        const gender = process.env.FISH_AUDIO_GENDER;
        if (gender) args.push('--gender', gender);
        const pitch = process.env.FISH_AUDIO_PITCH;
        if (pitch) args.push('--pitch', pitch);
        const cfgScale = process.env.FISH_AUDIO_CFG_SCALE;
        if (cfgScale) args.push('--cfg_scale', cfgScale);

        const pythonBin = resolvePython();
        await execFileAsync(pythonBin, args, {
          cwd: tmpDir,
          timeout: 120_000,  // 2 minute timeout
          maxBuffer: 50 * 1024 * 1024,  // 50 MB
        });
      } catch (err: unknown) {
        const msg = err instanceof Error
          ? (err as Error & { stderr?: string }).stderr || err.message
          : String(err);
        throw new Error(`Fish Audio TTS exec failed: ${msg.slice(0, 300)}`);
      }

      // Read the output WAV file
      const outputPath = join(tmpDir, 'audio_000.wav');
      if (!existsSync(outputPath)) {
        await rm(tmpDir, { recursive: true, force: true });
        throw new Error('Fish Audio TTS produced no output file');
      }

      const audio = await readFile(outputPath);

      // Clean up temp directory
      await rm(tmpDir, { recursive: true, force: true });

      // Calculate duration from WAV data (skip 44-byte header)
      // PCM 16-bit mono at 24kHz: bytes / (sampleRate * 2)
      const dataSize = audio.length - 44;
      const sampleRate = 24000;
      const durationSec = Math.max(1, dataSize / (sampleRate * 2));

      // Generate word-level timings distributed evenly
      const words = cleanText.split(/\s+/).filter((w) => w.length > 0);
      const timings = words.map((word, i) => ({
        word,
        t: Math.round((i * durationSec / words.length) * 100) / 100,
      }));

      return {
        audio,
        timings,
        durationSec: Math.round(durationSec * 100) / 100,
      };
    },
  };
}
