import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRecordingSessionSchema, type AgentRecordingSession, type AgentRecordingSessionState, type AgentRehearsalEvidence } from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';

interface StoredSession extends AgentRecordingSession {
  codexThreadId?: string;
  driverTokenHash?: string;
  driverSessionId?: string;
  targetApplicationId?: string;
  recordingId?: string;
  capProjectPath?: string;
  exportPath?: string;
  capturedAt?: string;
  stopAttempted?: boolean;
  recordingStopped?: boolean;
  retryAvailable?: 'export' | 'attachment';
  events?: Array<{ at: string; phase: string; message: string }>;
}

interface SessionTransitionDetails {
  message?: string;
  phase?: string;
  planFingerprint?: string;
  rehearsal?: AgentRehearsalEvidence;
  confirmedCapture?: boolean;
  codexThreadId?: string;
  driverTokenHash?: string;
  driverSessionId?: string;
  targetApplicationId?: string;
  recordingId?: string;
  capProjectPath?: string;
  exportPath?: string;
  capturedAt?: string;
  stopAttempted?: boolean;
  recordingStopped?: boolean;
  retryAvailable?: 'export' | 'attachment';
}

const terminal = new Set<AgentRecordingSessionState>(['completed', 'failed', 'interrupted']);
const transitions = {
  rehearsing: ['awaiting_confirmation', 'failed', 'interrupted'],
  awaiting_confirmation: ['recording', 'failed', 'interrupted'],
  recording: ['exporting', 'failed', 'interrupted'],
  exporting: ['attaching', 'failed', 'interrupted'],
  attaching: ['completed', 'failed', 'interrupted'],
  completed: [], failed: [], interrupted: [],
} satisfies Record<AgentRecordingSessionState, AgentRecordingSessionState[]>;

function directory(projectPath: string) { return join(projectPath, 'recording-plans', 'sessions'); }
function file(projectPath: string, id: string) { return join(directory(projectPath), `${id}.json`); }
function publicSession(session: StoredSession): AgentRecordingSession { return AgentRecordingSessionSchema.parse(session); }

export async function readStoredAgentRecordingSession(projectPath: string, id: string): Promise<StoredSession> {
  return JSON.parse(await readFile(file(projectPath, id), 'utf8')) as StoredSession;
}

export async function listStoredAgentRecordingSessions(projectPath: string): Promise<StoredSession[]> {
  let names: string[];
  try { names = await readdir(directory(projectPath)); } catch { return []; }
  return Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readStoredAgentRecordingSession(projectPath, name.slice(0, -5))));
}

async function writeStoredAgentRecordingSession(projectPath: string, session: StoredSession): Promise<void> {
  await atomicWriteFile(file(projectPath, session.id), JSON.stringify(session, null, 2));
}

function appendEvent(session: StoredSession, phase: string, message: string, at: string): StoredSession['events'] {
  return [...(session.events ?? []), { at, phase, message }].slice(-100);
}

async function ownedSession(projectPath: string, projectId: string, sceneId: string, sessionId: string): Promise<StoredSession> {
  const current = await readStoredAgentRecordingSession(projectPath, sessionId);
  if (current.projectId !== projectId || current.sceneId !== sceneId) throw new Error('Recording session does not belong to this scene.');
  return current;
}

export async function getCurrentAgentRecordingSession(projectPath: string, projectId: string, sceneId: string): Promise<AgentRecordingSession | null> {
  let names: string[];
  try { names = await readdir(directory(projectPath)); } catch { return null; }
  const sessions = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readStoredAgentRecordingSession(projectPath, name.slice(0, -5))));
  const match = sessions.filter((session) => session.projectId === projectId && session.sceneId === sceneId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return match ? publicSession(match) : null;
}

export async function findRecoverableAgentRecordingSession(projectPath: string, projectId: string, sceneId: string): Promise<AgentRecordingSession | null> {
  let names: string[];
  try { names = await readdir(directory(projectPath)); } catch { return null; }
  const sessions = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readStoredAgentRecordingSession(projectPath, name.slice(0, -5))));
  const match = sessions
    .filter((session) => session.projectId === projectId && session.sceneId === sceneId && (session.state === 'exporting' || session.state === 'attaching'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return match ? publicSession(match) : null;
}

export async function createAgentRecordingSession(projectPath: string, projectId: string, sceneId: string): Promise<AgentRecordingSession> {
  const current = await getCurrentAgentRecordingSession(projectPath, projectId, sceneId);
  if (current && !terminal.has(current.state)) throw new Error('An agent recording session is already active for this scene.');
  const now = new Date().toISOString();
  const session: StoredSession = {
    id: randomUUID(), projectId, sceneId, state: 'rehearsing', createdAt: now, updatedAt: now,
    events: [{ at: now, phase: 'rehearsing', message: 'Session created.' }],
  };
  await writeStoredAgentRecordingSession(projectPath, session);
  return publicSession(session);
}

export async function transitionAgentRecordingSession(
  projectPath: string,
  projectId: string,
  sceneId: string,
  sessionId: string,
  state: AgentRecordingSessionState,
  details: SessionTransitionDetails = {},
): Promise<AgentRecordingSession> {
  const current = await ownedSession(projectPath, projectId, sceneId, sessionId);
  if (!(transitions[current.state] as readonly AgentRecordingSessionState[]).includes(state)) throw new Error(`Cannot move recording session from ${current.state} to ${state}.`);
  if (state === 'awaiting_confirmation') {
    if (!details.planFingerprint?.trim() || details.rehearsal?.success !== true) throw new Error('Confirmation requires a successful rehearsal and plan fingerprint.');
  }
  if (state === 'recording') {
    if (!current.planFingerprint || current.rehearsal?.success !== true || !details.confirmedCapture || details.planFingerprint !== current.planFingerprint) throw new Error('Recording requires confirmation for the current successful rehearsal and plan fingerprint.');
  }
  const now = new Date().toISOString();
  const next: StoredSession = {
    ...current,
    ...details,
    state,
    updatedAt: now,
    events: appendEvent(current, details.phase ?? state, details.message ?? `Session moved to ${state}.`, now),
  };
  if (state === 'completed') {
    delete next.capProjectPath;
    delete next.exportPath;
  }
  await writeStoredAgentRecordingSession(projectPath, next);
  return publicSession(next);
}

export async function updateAgentRecordingSessionInternal(
  projectPath: string, projectId: string, sceneId: string, sessionId: string, details: SessionTransitionDetails,
): Promise<AgentRecordingSession> {
  const current = await ownedSession(projectPath, projectId, sceneId, sessionId);
  if (terminal.has(current.state)) throw new Error('A terminal recording session cannot be updated.');
  const now = new Date().toISOString();
  const next: StoredSession = {
    ...current, ...details, updatedAt: now,
    events: appendEvent(current, details.phase ?? current.phase ?? current.state, details.message ?? 'Session progress updated.', now),
  };
  await writeStoredAgentRecordingSession(projectPath, next);
  return publicSession(next);
}

export async function persistAgentRecordingIdentity(
  projectPath: string, projectId: string, sceneId: string, sessionId: string,
  started: { recordingId: string; projectPath: string }, capturedAt: string,
): Promise<AgentRecordingSession> {
  if (!started.recordingId.trim() || !started.projectPath.trim()) throw new Error('Cap recording identity is incomplete.');
  const current = await ownedSession(projectPath, projectId, sceneId, sessionId);
  if (current.state !== 'awaiting_confirmation') throw new Error('Cap recording identity can only be persisted before entering recording.');
  return updateAgentRecordingSessionInternal(projectPath, projectId, sceneId, sessionId, {
    recordingId: started.recordingId, capProjectPath: started.projectPath, capturedAt,
    phase: 'starting-recording', message: 'Cap started the confirmed recording.',
  });
}

export async function persistAgentRecordingStopped(
  projectPath: string, projectId: string, sceneId: string, sessionId: string,
  recordingId: string, stoppedProjectPath: string,
): Promise<void> {
  const current = await ownedSession(projectPath, projectId, sceneId, sessionId);
  if (!current.recordingId || current.recordingId !== recordingId) throw new Error('Stopped Cap recording identity does not match the persisted session.');
  if (!stoppedProjectPath.trim()) throw new Error('Stopped Cap project path is missing.');
  const pathMismatch = Boolean(current.capProjectPath && current.capProjectPath !== stoppedProjectPath);
  const now = new Date().toISOString();
  await writeStoredAgentRecordingSession(projectPath, {
    ...current, capProjectPath: current.capProjectPath ?? stoppedProjectPath, recordingStopped: true, updatedAt: now,
    events: appendEvent(current, 'recording-stopped', 'Cap finalized the exact recording metadata.', now),
  });
  if (pathMismatch) throw new Error('Cap stopped an unexpected project for the exact recording ID.');
}

export async function requireAttachableSession(projectPath: string, projectId: string, sceneId: string, sessionId: string): Promise<AgentRecordingSession> {
  const session = await ownedSession(projectPath, projectId, sceneId, sessionId);
  if (session.state !== 'attaching') throw new Error('Cap attachment requires this scene\'s session to be in attaching state.');
  return publicSession(session);
}
