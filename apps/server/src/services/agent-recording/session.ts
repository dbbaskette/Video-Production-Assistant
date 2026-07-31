import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRecordingSessionSchema, AgentRecordingSessionUpdateSchema, type AgentRecordingSession, type AgentRecordingSessionState } from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';

interface StoredSession extends AgentRecordingSession { capProjectPath?: string; exportPath?: string }
const terminal = new Set<AgentRecordingSessionState>(['completed', 'failed', 'interrupted']);
const transitions: Record<AgentRecordingSessionState, AgentRecordingSessionState[]> = {
  rehearsing: ['recording', 'failed', 'interrupted'],
  recording: ['exporting', 'failed', 'interrupted'],
  exporting: ['attaching', 'failed', 'interrupted'],
  attaching: ['completed', 'failed', 'interrupted'],
  completed: [], failed: [], interrupted: [],
};

function directory(projectPath: string) { return join(projectPath, 'recording-plans', 'sessions'); }
function file(projectPath: string, id: string) { return join(directory(projectPath), `${id}.json`); }
function publicSession(session: StoredSession): AgentRecordingSession { return AgentRecordingSessionSchema.parse(session); }

async function readStored(projectPath: string, id: string): Promise<StoredSession> {
  return JSON.parse(await readFile(file(projectPath, id), 'utf8')) as StoredSession;
}

async function expire(projectPath: string, session: StoredSession): Promise<StoredSession> {
  if (!terminal.has(session.state) && Date.now() - Date.parse(session.updatedAt) > 30 * 60_000) {
    const expired = { ...session, state: 'interrupted' as const, message: 'No update was received for 30 minutes.', updatedAt: new Date().toISOString() };
    await atomicWriteFile(file(projectPath, session.id), JSON.stringify(expired, null, 2));
    return expired;
  }
  return session;
}

export async function getCurrentAgentRecordingSession(projectPath: string, projectId: string, sceneId: string): Promise<AgentRecordingSession | null> {
  let names: string[];
  try { names = await readdir(directory(projectPath)); } catch { return null; }
  const sessions = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => expire(projectPath, await readStored(projectPath, name.slice(0, -5)))));
  const match = sessions.filter((session) => session.projectId === projectId && session.sceneId === sceneId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return match ? publicSession(match) : null;
}

export async function createAgentRecordingSession(projectPath: string, projectId: string, sceneId: string): Promise<AgentRecordingSession> {
  const current = await getCurrentAgentRecordingSession(projectPath, projectId, sceneId);
  if (current && !terminal.has(current.state)) throw new Error('An agent recording session is already active for this scene.');
  const now = new Date().toISOString();
  const session: StoredSession = { id: randomUUID(), projectId, sceneId, state: 'rehearsing', createdAt: now, updatedAt: now };
  await atomicWriteFile(file(projectPath, session.id), JSON.stringify(session, null, 2));
  return publicSession(session);
}

export async function updateAgentRecordingSession(projectPath: string, projectId: string, sceneId: string, sessionId: string, input: unknown): Promise<AgentRecordingSession> {
  const update = AgentRecordingSessionUpdateSchema.parse(input);
  const current = await expire(projectPath, await readStored(projectPath, sessionId));
  if (current.projectId !== projectId || current.sceneId !== sceneId) throw new Error('Recording session does not belong to this scene.');
  if (!transitions[current.state].includes(update.state)) throw new Error(`Cannot move recording session from ${current.state} to ${update.state}.`);
  const next: StoredSession = { ...current, ...update, updatedAt: new Date().toISOString() };
  if (update.state === 'completed') { delete next.capProjectPath; delete next.exportPath; }
  await atomicWriteFile(file(projectPath, sessionId), JSON.stringify(next, null, 2));
  return publicSession(next);
}

export async function requireAttachableSession(projectPath: string, projectId: string, sceneId: string, sessionId: string): Promise<AgentRecordingSession> {
  const session = await expire(projectPath, await readStored(projectPath, sessionId));
  if (session.projectId !== projectId || session.sceneId !== sceneId || session.state !== 'attaching') throw new Error('Cap attachment requires this scene\'s session to be in attaching state.');
  return publicSession(session);
}
