/**
 * Fish Audio TTS provider (local, via mlx_audio).
 *
 * Runs a local Python subprocess: `python3 -m mlx_audio.tts.generate`
 * using Fish Audio S2 Pro model (typically via LM Studio).
 *
 * Capabilities:
 *   • Multi-speaker via <|speaker:N|> tags (up to 5 speakers)
 *   • Voice cloning via --ref_audio + --ref_text
 *   • Rich inline tags: [laughing], [whisper], [excited], [pause], etc.
 *
 * No API key needed — this is a fully local provider.
 *
 * Environment variables:
 *   FISH_AUDIO_MODEL         – model path (default: ~/.lmstudio/models/mlx-community/fish-audio-s2-pro-bf16)
 *   FISH_AUDIO_SPEED         – speed multiplier (default: 1.0)
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
  const wsRoot = resolve(import.meta.dirname, '../../../../../..');
  const venvPython = join(wsRoot, '.venv', 'bin', 'python3');
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}

/** Expand ~ to home directory. */
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

const DEFAULT_MODEL = '~/.lmstudio/models/mlx-community/fish-audio-s2-pro-bf16';

export interface FishAudioConfig {
  modelPath: string;
  speed: number;
  temperature: number;
  style: string;
  exaggeration: number;
  refAudio?: string;
  refText?: string;
}

function loadFishConfig(): FishAudioConfig {
  return {
    modelPath: expandTilde(process.env.FISH_AUDIO_MODEL || DEFAULT_MODEL),
    speed: parseFloat(process.env.FISH_AUDIO_SPEED || '1.0'),
    temperature: parseFloat(process.env.FISH_AUDIO_TEMPERATURE || '0.7'),
    style: process.env.FISH_AUDIO_STYLE || '',
    exaggeration: parseFloat(process.env.FISH_AUDIO_EXAGGERATION || '0.3'),
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
    displayName: 'Fish Audio S2 Pro (local)',
    // Fish S2 Pro supports rich inline tags — these map to the free-form tag system
    supportedEmotives: new Set([
      'warm', 'confident', 'calm', 'excited', 'serious', 'friendly',
      'professional', 'enthusiastic',
      // S2 Pro native tags
      'pause', 'emphasis', 'laughing', 'whisper', 'singing',
      'angry', 'sad', 'surprised', 'shouting', 'loud',
    ]),
    voices: [
      {
        id: 'speaker-0',
        name: 'Speaker 0',
        description: 'Default voice — anonymous speaker slot',
      },
      {
        id: 'speaker-1',
        name: 'Speaker 1',
        description: 'Second voice — for dialog / conversation',
      },
      {
        id: 'speaker-2',
        name: 'Speaker 2',
        description: 'Third voice — multi-speaker scenarios',
      },
      {
        id: 'clone',
        name: 'Voice Clone',
        description: config.refAudio
          ? `Cloned from: ${config.refAudio}`
          : 'Set FISH_AUDIO_REF_AUDIO to enable voice cloning',
      },
    ],

    async generate(script: string, opts: TtsGenerateOpts): Promise<TtsResult> {
      const speed = opts.speed ?? config.speed;
      const voiceId = opts.voice ?? 'speaker-0';

      // Fish S2 Pro uses inline tags natively — don't strip them
      let processedText = script;

      // For numbered speaker voices, prepend the speaker tag
      if (voiceId.startsWith('speaker-')) {
        const speakerNum = voiceId.replace('speaker-', '');
        // Only prepend if text doesn't already have speaker tags
        if (!processedText.includes('<|speaker:')) {
          processedText = `<|speaker:${speakerNum}|>${processedText}`;
        }
      }

      // Prepend style tag if configured (e.g. "[enthusiastic professional narrator]")
      if (config.style) {
        processedText = `[${config.style}] ${processedText}`;
      }

      // Create temp output directory
      const tmpDir = join(tmpdir(), `vpa-fish-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });

      try {
        const args = [
          '-m', 'mlx_audio.tts.generate',
          '--model', config.modelPath,
          '--text', processedText,
          '--output_path', tmpDir,
          '--audio_format', 'wav',
        ];

        if (speed !== 1.0) args.push('--speed', String(speed));
        if (config.temperature) args.push('--temperature', String(config.temperature));
        if (config.exaggeration !== 0.3) args.push('--exaggeration', String(config.exaggeration));

        // Voice cloning via reference audio
        // Accept runtime refAudio (from opts) or fall back to config
        const refAudio = (opts as any).refAudio ?? config.refAudio;
        const refText = (opts as any).refText ?? config.refText;

        if (voiceId === 'clone' && refAudio) {
          args.push('--ref_audio', refAudio);
          if (refText) args.push('--ref_text', refText);
        } else if (refAudio && voiceId === 'speaker-0') {
          // For speaker-0, use reference audio if configured (default voice cloning)
          args.push('--ref_audio', refAudio);
          if (refText) args.push('--ref_text', refText);
        }

        const pythonBin = resolvePython();
        await execFileAsync(pythonBin, args, {
          cwd: tmpDir,
          timeout: 180_000,  // 3 minute timeout for longer passages
          maxBuffer: 50 * 1024 * 1024,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error
          ? (err as Error & { stderr?: string }).stderr || err.message
          : String(err);
        throw new Error(`Fish Audio TTS failed: ${msg.slice(0, 500)}`);
      }

      // Read the output WAV file (mlx_audio writes audio_000.wav)
      const outputPath = join(tmpDir, 'audio_000.wav');
      if (!existsSync(outputPath)) {
        await rm(tmpDir, { recursive: true, force: true });
        throw new Error('Fish Audio TTS produced no output file');
      }

      const audio = await readFile(outputPath);
      await rm(tmpDir, { recursive: true, force: true });

      // Parse WAV duration from header
      const durationSec = parseWavDuration(audio);

      // Generate word-level timings distributed evenly
      const cleanText = script.replace(/\[[\w\s-]+\]/g, '').replace(/<\|speaker:\d+\|>/g, '').trim();
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

  // Walk sub-chunks to find "data"
  let offset = 36;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return Math.max(0.1, chunkSize / (sampleRate * bytesPerSample));
    }
    offset += 8 + chunkSize;
  }

  // Fallback
  return Math.max(0.1, (buf.length - 44) / (sampleRate * bytesPerSample));
}
