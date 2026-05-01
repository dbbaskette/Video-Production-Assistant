import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface VoiceProfile {
  id: string; // filename stem, e.g. 'tanzu-narrator'
  name: string;
  engine: string;
  voice: string;
  speed: number;
  description?: string;
}

const DEFAULT_PROFILE: VoiceProfile = {
  id: 'default-narrator',
  name: 'Default Narrator',
  engine: 'fake',
  voice: 'alice',
  speed: 1.0,
  description: 'Default narrator voice for development',
};

function voicesDir(vpaHome: string): string {
  return join(vpaHome, 'voices');
}

function profilePath(vpaHome: string, profileId: string): string {
  return join(voicesDir(vpaHome), `${profileId}.yaml`);
}

async function ensureDir(vpaHome: string): Promise<void> {
  await mkdir(voicesDir(vpaHome), { recursive: true });
}

/** Ensure the default profile exists on first access. */
async function ensureDefaults(vpaHome: string): Promise<void> {
  await ensureDir(vpaHome);
  const dir = voicesDir(vpaHome);
  try {
    const entries = await readdir(dir);
    const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (yamlFiles.length === 0) {
      await saveProfile(vpaHome, DEFAULT_PROFILE);
    }
  } catch {
    await saveProfile(vpaHome, DEFAULT_PROFILE);
  }
}

export async function listProfiles(vpaHome: string): Promise<VoiceProfile[]> {
  await ensureDefaults(vpaHome);
  const dir = voicesDir(vpaHome);
  const entries = await readdir(dir);
  const profiles: VoiceProfile[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const id = entry.replace(/\.ya?ml$/, '');
    try {
      const content = await readFile(join(dir, entry), 'utf-8');
      const data = yaml.load(content) as Record<string, unknown>;
      profiles.push({
        id,
        name: String(data.name ?? id),
        engine: String(data.engine ?? 'fake'),
        voice: String(data.voice ?? 'alice'),
        speed: Number(data.speed ?? 1.0),
        description: data.description ? String(data.description) : undefined,
      });
    } catch {
      // Skip malformed files
    }
  }

  return profiles;
}

export async function getProfile(
  vpaHome: string,
  profileId: string,
): Promise<VoiceProfile | null> {
  await ensureDir(vpaHome);
  const path = profilePath(vpaHome, profileId);
  try {
    const content = await readFile(path, 'utf-8');
    const data = yaml.load(content) as Record<string, unknown>;
    return {
      id: profileId,
      name: String(data.name ?? profileId),
      engine: String(data.engine ?? 'fake'),
      voice: String(data.voice ?? 'alice'),
      speed: Number(data.speed ?? 1.0),
      description: data.description ? String(data.description) : undefined,
    };
  } catch {
    return null;
  }
}

export async function saveProfile(vpaHome: string, profile: VoiceProfile): Promise<void> {
  await ensureDir(vpaHome);
  const content = yaml.dump({
    name: profile.name,
    engine: profile.engine,
    voice: profile.voice,
    speed: profile.speed,
    ...(profile.description ? { description: profile.description } : {}),
  });
  await writeFile(profilePath(vpaHome, profile.id), content, 'utf-8');
}

export async function deleteProfile(vpaHome: string, profileId: string): Promise<boolean> {
  try {
    await rm(profilePath(vpaHome, profileId));
    return true;
  } catch {
    return false;
  }
}
