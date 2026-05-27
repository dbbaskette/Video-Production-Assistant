import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { VoiceCloneSchema, type VoiceClone, type VoiceCloneUpdate } from '@vpa/shared';

/**
 * Voice clone storage layout:
 *
 *   ~/.vpa/voice-clones/<slug>/
 *     audio.wav        # 24 kHz mono 16-bit WAV (canonical)
 *     transcript.txt   # optional
 *     voice.json       # metadata + provider registrations
 */

export interface VoiceCloneStoreOptions {
  vpaHome: string;
}

const META_FILENAME = 'voice.json';
const AUDIO_FILENAME = 'audio.wav';
const TRANSCRIPT_FILENAME = 'transcript.txt';

export class VoiceCloneStore {
  constructor(private readonly opts: VoiceCloneStoreOptions) {}

  private get root(): string {
    return join(this.opts.vpaHome, 'voice-clones');
  }

  voiceDir(id: string): string {
    return join(this.root, id);
  }

  audioPath(id: string): string {
    return join(this.voiceDir(id), AUDIO_FILENAME);
  }

  /**
   * Migrate legacy flat-file clones (`<base>.wav` + `<base>.txt`) into the per-voice
   * directory layout. Idempotent: skips entries that already have a voice.json.
   */
  async migrateLegacy(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.wav')) continue;
      const wavPath = join(this.root, entry);
      const wavStat = await stat(wavPath).catch(() => null);
      if (!wavStat || !wavStat.isFile()) continue;
      const base = entry.replace(/\.wav$/, '');
      const slug = slugify(base);
      const dir = this.voiceDir(slug);
      // Skip if already migrated
      const metaExists = await stat(join(dir, META_FILENAME)).catch(() => null);
      if (metaExists) continue;

      await mkdir(dir, { recursive: true });
      // Move audio + transcript
      await rename(wavPath, join(dir, AUDIO_FILENAME));
      const txtPath = join(this.root, `${base}.txt`);
      try {
        const transcript = await readFile(txtPath, 'utf-8');
        await writeFile(join(dir, TRANSCRIPT_FILENAME), transcript, 'utf-8');
        await rm(txtPath, { force: true });
      } catch { /* no transcript */ }

      const voice: VoiceClone = {
        id: slug,
        name: base,
        createdAt: wavStat.birthtime.toISOString(),
        hasAudio: true,
        providers: {},
      };
      await this.writeMeta(slug, voice);
    }
  }

  async list(): Promise<VoiceClone[]> {
    let entries: string[];
    try {
      await mkdir(this.root, { recursive: true });
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    const voices: VoiceClone[] = [];
    for (const entry of entries) {
      const dir = join(this.root, entry);
      const dirStat = await stat(dir).catch(() => null);
      if (!dirStat || !dirStat.isDirectory()) continue;
      try {
        const voice = await this.read(entry);
        voices.push(voice);
      } catch {
        // skip malformed entries
      }
    }
    return voices.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(id: string): Promise<VoiceClone> {
    const metaPath = join(this.voiceDir(id), META_FILENAME);
    const text = await readFile(metaPath, 'utf-8');
    const parsed = VoiceCloneSchema.parse(JSON.parse(text));
    // Refresh hasAudio / isTrimmed based on filesystem reality
    const audioStat = await stat(this.audioPath(id)).catch(() => null);
    const fullStat = await stat(join(this.voiceDir(id), 'audio.full.wav')).catch(() => null);
    return {
      ...parsed,
      hasAudio: !!audioStat?.isFile(),
      isTrimmed: !!fullStat?.isFile(),
    };
  }

  async create(input: {
    name: string;
    description?: string;
    metadata?: Partial<VoiceCloneUpdate>;
    audioBuffer?: Buffer;
    transcript?: string;
  }): Promise<VoiceClone> {
    const slug = await this.uniqueSlug(slugify(input.name));
    const dir = this.voiceDir(slug);
    await mkdir(dir, { recursive: true });

    if (input.audioBuffer) {
      await writeFile(this.audioPath(slug), input.audioBuffer);
    }
    if (input.transcript !== undefined) {
      await writeFile(join(dir, TRANSCRIPT_FILENAME), input.transcript, 'utf-8');
    }

    const meta = input.metadata ?? {};
    const voice: VoiceClone = {
      id: slug,
      name: input.name,
      description: input.description ?? meta.description ?? undefined,
      transcript: input.transcript ?? undefined,
      createdAt: new Date().toISOString(),
      hasAudio: !!input.audioBuffer,
      gender: meta.gender ?? undefined,
      age: meta.age ?? undefined,
      accent: meta.accent ?? undefined,
      language: meta.language ?? undefined,
      use_case: meta.use_case ?? undefined,
      tone: meta.tone ?? undefined,
      providers: {},
    };
    await this.writeMeta(slug, voice);
    return voice;
  }

  async update(id: string, patch: VoiceCloneUpdate): Promise<VoiceClone> {
    const current = await this.read(id);
    const merged: VoiceClone = { ...current };
    // Apply patch — `null` clears the field
    for (const [k, v] of Object.entries(patch) as [keyof VoiceCloneUpdate, unknown][]) {
      if (v === null) {
        delete (merged as Record<string, unknown>)[k as string];
      } else if (v !== undefined) {
        (merged as Record<string, unknown>)[k as string] = v;
      }
    }
    // Persist transcript file alongside if it changed
    if (Object.prototype.hasOwnProperty.call(patch, 'transcript')) {
      const txtPath = join(this.voiceDir(id), TRANSCRIPT_FILENAME);
      if (patch.transcript === null || patch.transcript === undefined || patch.transcript === '') {
        await rm(txtPath, { force: true });
      } else {
        await writeFile(txtPath, patch.transcript, 'utf-8');
      }
    }
    await this.writeMeta(id, merged);
    return merged;
  }

  async replaceAudio(id: string, buffer: Buffer): Promise<VoiceClone> {
    await mkdir(this.voiceDir(id), { recursive: true });
    await writeFile(this.audioPath(id), buffer);
    const voice = await this.read(id);
    return voice;
  }

  /** Save (or overwrite) the xAI registration on this voice. */
  async setXaiRegistration(id: string, voice_id: string, opts: { imported?: boolean } = {}): Promise<VoiceClone> {
    const current = await this.read(id);
    const next: VoiceClone = {
      ...current,
      providers: {
        ...current.providers,
        xai: {
          voice_id,
          registeredAt: new Date().toISOString(),
          ...(opts.imported ? { imported: true } : {}),
        },
      },
    };
    await this.writeMeta(id, next);
    return next;
  }

  async clearXaiRegistration(id: string): Promise<VoiceClone> {
    const current = await this.read(id);
    const { xai: _drop, ...rest } = current.providers;
    void _drop;
    const next: VoiceClone = { ...current, providers: rest };
    await this.writeMeta(id, next);
    return next;
  }

  async delete(id: string): Promise<void> {
    await rm(this.voiceDir(id), { recursive: true, force: true });
  }

  private async writeMeta(id: string, voice: VoiceClone): Promise<void> {
    await mkdir(this.voiceDir(id), { recursive: true });
    const metaPath = join(this.voiceDir(id), META_FILENAME);
    await atomicWriteFile(metaPath, JSON.stringify(voice, null, 2));
  }

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base || 'voice';
    let n = 0;
    while (true) {
      const candidate = n === 0 ? slug : `${slug}-${n}`;
      const exists = await stat(this.voiceDir(candidate)).catch(() => null);
      if (!exists) return candidate;
      n += 1;
    }
  }
}

/** Convert any string to a safe slug. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'voice';
}
