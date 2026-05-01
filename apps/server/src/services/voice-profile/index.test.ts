import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProfiles, getProfile, saveProfile, deleteProfile } from './index.js';
import type { VoiceProfile } from './index.js';

describe('voice-profile service', () => {
  let vpaHome: string;

  beforeEach(async () => {
    vpaHome = await mkdtemp(path.join(tmpdir(), 'vpa-voice-'));
  });

  afterEach(async () => {
    await rm(vpaHome, { recursive: true, force: true });
  });

  it('creates default profile on first listProfiles call', async () => {
    const profiles = await listProfiles(vpaHome);
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    const def = profiles.find((p) => p.id === 'default-narrator');
    expect(def).toBeDefined();
    expect(def!.engine).toBe('fake');
    expect(def!.voice).toBe('alice');
  });

  it('saves and retrieves a profile', async () => {
    const profile: VoiceProfile = {
      id: 'test-voice',
      name: 'Test Voice',
      engine: 'gemini',
      voice: 'Kore',
      speed: 1.2,
      description: 'A test voice profile',
    };
    await saveProfile(vpaHome, profile);
    const retrieved = await getProfile(vpaHome, 'test-voice');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Test Voice');
    expect(retrieved!.engine).toBe('gemini');
    expect(retrieved!.voice).toBe('Kore');
    expect(retrieved!.speed).toBe(1.2);
    expect(retrieved!.description).toBe('A test voice profile');
  });

  it('lists all profiles', async () => {
    await saveProfile(vpaHome, {
      id: 'voice-a',
      name: 'Voice A',
      engine: 'fake',
      voice: 'alice',
      speed: 1.0,
    });
    await saveProfile(vpaHome, {
      id: 'voice-b',
      name: 'Voice B',
      engine: 'fake',
      voice: 'bob',
      speed: 0.8,
    });
    const profiles = await listProfiles(vpaHome);
    // voice-a + voice-b (+ possibly default if ensureDefaults ran first)
    expect(profiles.length).toBeGreaterThanOrEqual(2);
    expect(profiles.some((p) => p.id === 'voice-a')).toBe(true);
    expect(profiles.some((p) => p.id === 'voice-b')).toBe(true);
  });

  it('deletes a profile', async () => {
    await saveProfile(vpaHome, {
      id: 'to-delete',
      name: 'Delete Me',
      engine: 'fake',
      voice: 'carol',
      speed: 1.0,
    });
    expect(await getProfile(vpaHome, 'to-delete')).toBeDefined();
    const deleted = await deleteProfile(vpaHome, 'to-delete');
    expect(deleted).toBe(true);
    expect(await getProfile(vpaHome, 'to-delete')).toBeNull();
  });

  it('returns null for nonexistent profile', async () => {
    expect(await getProfile(vpaHome, 'nonexistent')).toBeNull();
  });

  it('returns false when deleting nonexistent profile', async () => {
    expect(await deleteProfile(vpaHome, 'nonexistent')).toBe(false);
  });
});
