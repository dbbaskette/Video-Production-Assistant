import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentRecordingSession, getCurrentAgentRecordingSession, requireAttachableSession, updateAgentRecordingSession } from './session.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'vpa-session-')); roots.push(value); return value; }

describe('agent recording sessions', () => {
  it('enforces the rehearsal-to-attachment lifecycle', async () => {
    const projectPath = await root();
    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    expect(created.state).toBe('rehearsing');
    await expect(updateAgentRecordingSession(projectPath, 'project', 'scene', created.id, { state: 'attaching' })).rejects.toThrow('Cannot move');
    await updateAgentRecordingSession(projectPath, 'project', 'scene', created.id, { state: 'recording', recordingId: 'cap-1' });
    await updateAgentRecordingSession(projectPath, 'project', 'scene', created.id, { state: 'exporting' });
    const attaching = await updateAgentRecordingSession(projectPath, 'project', 'scene', created.id, { state: 'attaching', exportPath: '/tmp/take.mp4' });
    expect(await requireAttachableSession(projectPath, 'project', 'scene', attaching.id)).toMatchObject({ state: 'attaching' });
    expect(await getCurrentAgentRecordingSession(projectPath, 'project', 'scene')).toMatchObject({ recordingId: 'cap-1' });
  });
});
