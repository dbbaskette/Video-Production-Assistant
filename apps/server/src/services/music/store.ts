/**
 * Per-project music track storage.
 *
 *   <project>/music/<trackId>.mp3   — audio bytes
 *   <project>/music/<trackId>.json  — { id, prompt, model, modelId, format,
 *                                       generatedAt, lyrics?, sizeBytes }
 *
 * Tracks are scoped to a project (the prompt is usually project-specific).
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import type { LyriaModel } from './lyria.js';

export interface MusicTrack {
  id: string;
  prompt: string;
  model: LyriaModel;
  modelId: string;
  format: 'mp3' | 'wav';
  generatedAt: string;
  lyrics?: string;
  sizeBytes: number;
}

function musicDir(projectPath: string): string {
  return join(projectPath, 'music');
}

function trackAudioPath(projectPath: string, track: MusicTrack): string {
  return join(musicDir(projectPath), `${track.id}.${track.format}`);
}

function metaPath(projectPath: string, id: string): string {
  return join(musicDir(projectPath), `${id}.json`);
}

export async function ensureMusicDir(projectPath: string): Promise<void> {
  await mkdir(musicDir(projectPath), { recursive: true });
}

export async function saveTrack(
  projectPath: string,
  input: {
    audio: Buffer;
    prompt: string;
    model: LyriaModel;
    modelId: string;
    format: 'mp3' | 'wav';
    lyrics?: string;
  },
): Promise<MusicTrack> {
  await ensureMusicDir(projectPath);
  const id = `track-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const track: MusicTrack = {
    id,
    prompt: input.prompt,
    model: input.model,
    modelId: input.modelId,
    format: input.format,
    generatedAt: new Date().toISOString(),
    lyrics: input.lyrics,
    sizeBytes: input.audio.length,
  };
  await writeFile(trackAudioPath(projectPath, track), input.audio);
  await atomicWriteFile(metaPath(projectPath, id), JSON.stringify(track, null, 2));
  return track;
}

export async function listTracks(projectPath: string): Promise<MusicTrack[]> {
  let entries: string[];
  try {
    await ensureMusicDir(projectPath);
    entries = await readdir(musicDir(projectPath));
  } catch {
    return [];
  }
  const tracks: MusicTrack[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const text = await readFile(join(musicDir(projectPath), entry), 'utf-8');
      const t = JSON.parse(text) as MusicTrack;
      if (typeof t.id === 'string') tracks.push(t);
    } catch { /* skip malformed entries */ }
  }
  return tracks.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function readTrack(projectPath: string, id: string): Promise<MusicTrack | null> {
  try {
    const text = await readFile(metaPath(projectPath, id), 'utf-8');
    return JSON.parse(text) as MusicTrack;
  } catch {
    return null;
  }
}

export function audioPathFor(projectPath: string, track: MusicTrack): string {
  return trackAudioPath(projectPath, track);
}

export async function deleteTrack(projectPath: string, id: string): Promise<boolean> {
  const track = await readTrack(projectPath, id);
  if (!track) return false;
  await rm(trackAudioPath(projectPath, track), { force: true });
  await rm(metaPath(projectPath, id), { force: true });
  return true;
}

/** Whether an audio file actually exists on disk for the given track. */
export async function trackAudioExists(projectPath: string, track: MusicTrack): Promise<boolean> {
  try {
    const s = await stat(trackAudioPath(projectPath, track));
    return s.isFile();
  } catch {
    return false;
  }
}

export { basename };
