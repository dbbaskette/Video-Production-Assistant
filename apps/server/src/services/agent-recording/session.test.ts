import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentRecordingSession, findRecoverableAgentRecordingSession, getCurrentAgentRecordingSession, readStoredAgentRecordingSession, requireAttachableSession, transitionAgentRecordingSession } from './session.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'vpa-session-')); roots.push(value); return value; }

const rehearsal = {
  success: true, targetApplication: 'Safari', windowTitle: 'Demo', windowBounds: { x: 0, y: 0, width: 100, height: 100 },
  completedStepIndexes: [0], checkpoints: [{ description: 'Ready', passed: true }], resetConfirmed: true,
};

describe('agent recording sessions', () => {
  it('enforces rehearsal, confirmation, and attachment lifecycle', async () => {
    const projectPath = await root();
    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'recording')).rejects.toThrow('Cannot move');
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation')).rejects.toThrow('successful rehearsal and plan fingerprint');
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal: { ...rehearsal, success: false } })).rejects.toThrow('successful rehearsal and plan fingerprint');
    const awaiting = await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal });
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'recording', { confirmedCapture: true, planFingerprint: 'stale' })).rejects.toThrow('current successful rehearsal and plan fingerprint');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'recording', { confirmedCapture: true, planFingerprint: 'plan-1', recordingId: 'cap-1' });
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'exporting', { capProjectPath: '/tmp/cap-project' });
    const attaching = await transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'attaching', { exportPath: '/tmp/take.mp4' });
    expect(await requireAttachableSession(projectPath, 'project', 'scene', attaching.id)).toMatchObject({ state: 'attaching' });
    const completed = await transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'completed');
    expect(completed).toMatchObject({ state: 'completed', confirmedCapture: true });
  });

  it('does not expose private Cap data and caps session events', async () => {
    const projectPath = await root();
    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', {
      planFingerprint: 'plan-1', rehearsal, recordingId: 'cap-1', capProjectPath: '/private/cap', exportPath: '/private/take.mp4',
      codexThreadId: 'thread', driverTokenHash: 'token', targetApplicationId: 'safari',
    });
    const publicSession = await getCurrentAgentRecordingSession(projectPath, 'project', 'scene');
    expect(publicSession).not.toHaveProperty('recordingId');
    expect(publicSession).not.toHaveProperty('capProjectPath');
    expect(publicSession).not.toHaveProperty('exportPath');
    expect(await readStoredAgentRecordingSession(projectPath, created.id)).toMatchObject({ recordingId: 'cap-1', capProjectPath: '/private/cap' });

    const stored = await readStoredAgentRecordingSession(projectPath, created.id);
    await writeFile(join(projectPath, 'recording-plans', 'sessions', `${created.id}.json`), JSON.stringify({
      ...stored,
      events: Array.from({ length: 100 }, (_, index) => ({ at: stored.createdAt, phase: 'progress', message: String(index) })),
    }));
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'recording', { confirmedCapture: true, planFingerprint: 'plan-1' });
    expect((await readStoredAgentRecordingSession(projectPath, created.id)).events).toHaveLength(100);
  });

  it('expires stale sessions and finds recoverable exporting sessions', async () => {
    const projectPath = await root();
    const stale = await createAgentRecordingSession(projectPath, 'project', 'stale-scene');
    const staleFile = join(projectPath, 'recording-plans', 'sessions', `${stale.id}.json`);
    const stored = await readStoredAgentRecordingSession(projectPath, stale.id);
    await writeFile(staleFile, JSON.stringify({ ...stored, updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
    expect(await getCurrentAgentRecordingSession(projectPath, 'project', 'stale-scene')).toMatchObject({ state: 'interrupted' });

    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal });
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'recording', { confirmedCapture: true, planFingerprint: 'plan-1' });
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'exporting');
    expect(await findRecoverableAgentRecordingSession(projectPath, 'project', 'scene')).toMatchObject({ id: created.id, state: 'exporting' });
  });
});
