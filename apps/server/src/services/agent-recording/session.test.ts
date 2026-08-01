import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAgentRecordingPrivateDiagnostic, createAgentRecordingSession, findRecoverableAgentRecordingSession, getCurrentAgentRecordingSession, persistAgentRecordingIdentity, persistAgentRecordingStopped, readStoredAgentRecordingSession, requireAttachableSession, transitionAgentRecordingSession, updateAgentRecordingSessionInternal } from './session.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'vpa-session-')); roots.push(value); return value; }

const rehearsal = {
  success: true, targetApplication: 'Safari', windowTitle: 'Demo', windowBounds: { x: 0, y: 0, width: 100, height: 100 },
  completedStepIndexes: [0], checkpoints: [{ description: 'Ready', passed: true }], resetConfirmed: true,
};
const targetIdentity = {
  cap: { kind: 'window' as const, id: '42', name: 'Demo', application: 'Safari', width: 100, height: 100 },
  desktop: { bundleId: 'com.apple.Safari', displayName: 'Safari', processId: 7, windowId: 42, windowTitle: 'Demo', bounds: { x: 0, y: 0, width: 100, height: 100 } },
};

async function reachRecording(projectPath: string, projectId: string, sceneId: string, sessionId: string) {
  await transitionAgentRecordingSession(projectPath, projectId, sceneId, sessionId, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal, rehearsedTargetIdentity: targetIdentity });
  await persistAgentRecordingIdentity(projectPath, projectId, sceneId, sessionId, { recordingId: 'cap-1', projectPath: '/tmp/cap-project' }, '2026-07-31T12:00:00.000Z');
  await transitionAgentRecordingSession(projectPath, projectId, sceneId, sessionId, 'recording', { confirmedCapture: true, planFingerprint: 'plan-1' });
}

describe('agent recording sessions', () => {
  it('enforces rehearsal, confirmation, and attachment lifecycle', async () => {
    const projectPath = await root();
    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'recording')).rejects.toThrow('Cannot move');
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation')).rejects.toThrow('successful rehearsal, exact target identity, and plan fingerprint');
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal: { ...rehearsal, success: false }, rehearsedTargetIdentity: targetIdentity })).rejects.toThrow('successful rehearsal, exact target identity, and plan fingerprint');
    const awaiting = await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal, rehearsedTargetIdentity: targetIdentity });
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'recording', { confirmedCapture: true, planFingerprint: 'stale' })).rejects.toThrow('current successful rehearsal and plan fingerprint');
    await persistAgentRecordingIdentity(projectPath, 'project', 'scene', awaiting.id, { recordingId: 'cap-1', projectPath: '/tmp/cap-project' }, '2026-07-31T12:00:00.000Z');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'recording', { confirmedCapture: true, planFingerprint: 'plan-1' });
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'exporting')).rejects.toThrow('confirmed stop metadata');
    await persistAgentRecordingStopped(projectPath, 'project', 'scene', awaiting.id, 'cap-1', '/tmp/cap-project');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'exporting');
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'attaching', { exportPath: '/tmp/take.mp4' })).rejects.toThrow('validated Cap project');
    await updateAgentRecordingSessionInternal(projectPath, 'project', 'scene', awaiting.id, { projectValidated: true });
    const attaching = await transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'attaching', { exportPath: '/tmp/take.mp4', exportVerified: { sizeBytes: 3, sha256: 'a'.repeat(64) } });
    expect(await requireAttachableSession(projectPath, 'project', 'scene', attaching.id)).toMatchObject({ state: 'attaching' });
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'completed')).rejects.toThrow('ingestion verification');
    await updateAgentRecordingSessionInternal(projectPath, 'project', 'scene', awaiting.id, { ingestVerified: true });
    const completed = await transitionAgentRecordingSession(projectPath, 'project', 'scene', awaiting.id, 'completed');
    expect(completed).toMatchObject({ state: 'completed', confirmedCapture: true });
  });

  it('does not expose private Cap data and caps session events', async () => {
    const projectPath = await root();
    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', {
      planFingerprint: 'plan-1', rehearsal, rehearsedTargetIdentity: targetIdentity, recordingId: 'cap-1', capProjectPath: '/private/cap', exportPath: '/private/take.mp4',
      codexThreadId: 'thread', driverTokenHash: 'token', targetApplicationId: 'safari',
    });
    for (let index = 0; index < 25; index += 1) {
      await appendAgentRecordingPrivateDiagnostic(projectPath, 'project', 'scene', created.id, {
        category: 'local', phase: 'test', detail: `Useful failure ${index} token=raw-secret /private/file`,
      }, ['raw-secret']);
    }
    const publicSession = await getCurrentAgentRecordingSession(projectPath, 'project', 'scene');
    expect(publicSession).not.toHaveProperty('recordingId');
    expect(publicSession).not.toHaveProperty('capProjectPath');
    expect(publicSession).not.toHaveProperty('exportPath');
    expect(publicSession).not.toHaveProperty('rehearsedTargetIdentity');
    expect(publicSession).not.toHaveProperty('privateDiagnostics');
    const privateSession = await readStoredAgentRecordingSession(projectPath, created.id);
    expect(privateSession).toMatchObject({ recordingId: 'cap-1', capProjectPath: '/private/cap' });
    expect(privateSession.privateDiagnostics).toHaveLength(20);
    expect(privateSession.privateDiagnostics?.[0]).toMatchObject({ category: 'local', detail: expect.stringContaining('Useful failure 5') });
    expect(JSON.stringify(privateSession.privateDiagnostics)).not.toMatch(/raw-secret|\/private\/file/);

    const stored = await readStoredAgentRecordingSession(projectPath, created.id);
    await writeFile(join(projectPath, 'recording-plans', 'sessions', `${created.id}.json`), JSON.stringify({
      ...stored,
      events: Array.from({ length: 100 }, (_, index) => ({ at: stored.createdAt, phase: 'progress', message: String(index) })),
    }));
    await persistAgentRecordingIdentity(projectPath, 'project', 'scene', created.id, { recordingId: 'cap-1', projectPath: '/private/cap' }, '2026-07-31T12:00:00.000Z');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'recording', { confirmedCapture: true, planFingerprint: 'plan-1' });
    expect((await readStoredAgentRecordingSession(projectPath, created.id)).events).toHaveLength(100);
  });

  it('persists exact Cap identity atomically before the recording transition', async () => {
    const projectPath = await root();
    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal, rehearsedTargetIdentity: targetIdentity });
    await persistAgentRecordingIdentity(projectPath, 'project', 'scene', created.id, { recordingId: 'cap-exact', projectPath: '/private/take.cap' }, '2026-07-31T12:00:00.000Z');
    expect(await readStoredAgentRecordingSession(projectPath, created.id)).toMatchObject({
      state: 'awaiting_confirmation', recordingId: 'cap-exact', capProjectPath: '/private/take.cap', capturedAt: '2026-07-31T12:00:00.000Z',
    });
  });

  it('leaves stale lifecycle decisions to the coordinator and finds recoverable exporting sessions', async () => {
    const projectPath = await root();
    const stale = await createAgentRecordingSession(projectPath, 'project', 'stale-scene');
    const staleFile = join(projectPath, 'recording-plans', 'sessions', `${stale.id}.json`);
    const stored = await readStoredAgentRecordingSession(projectPath, stale.id);
    await writeFile(staleFile, JSON.stringify({ ...stored, updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
    expect(await getCurrentAgentRecordingSession(projectPath, 'project', 'stale-scene')).toMatchObject({ state: 'rehearsing' });

    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    await reachRecording(projectPath, 'project', 'scene', created.id);
    await persistAgentRecordingStopped(projectPath, 'project', 'scene', created.id, 'cap-1', '/tmp/cap-project');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'exporting');
    await updateAgentRecordingSessionInternal(projectPath, 'project', 'scene', created.id, { projectValidated: true });
    expect(await findRecoverableAgentRecordingSession(projectPath, 'project', 'scene')).toMatchObject({ id: created.id, state: 'exporting' });
  });

  it('rejects lifecycle transitions that skip required durable artifacts', async () => {
    const projectPath = await root();
    const created = await createAgentRecordingSession(projectPath, 'project', 'scene');
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal })).rejects.toThrow('exact target identity');
    await transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'awaiting_confirmation', { planFingerprint: 'plan-1', rehearsal, rehearsedTargetIdentity: targetIdentity });
    await expect(transitionAgentRecordingSession(projectPath, 'project', 'scene', created.id, 'recording', { confirmedCapture: true, planFingerprint: 'plan-1' })).rejects.toThrow('persisted exact Cap identity');
  });
});
