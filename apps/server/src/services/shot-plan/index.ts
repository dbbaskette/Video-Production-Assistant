import { randomUUID } from 'node:crypto';

export interface ShotPlanStep {
  index: number;
  action: string;
  note?: string;
}

export interface ShotPlanChatTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

/**
 * Parse the steps array from an LLM reply.
 * Expects a fenced ```json block containing `{ "steps": [ { index, action, note? } ] }`.
 * Empty actions are dropped; missing indices are renumbered 1-based in order.
 */
export function parseStepsFromResponse(text: string): ShotPlanStep[] {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m || !m[1]) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1].trim());
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { steps?: unknown }).steps)
  ) {
    return [];
  }
  const raw = (parsed as { steps: unknown[] }).steps;
  const cleaned: ShotPlanStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const obj = s as Record<string, unknown>;
    const action = typeof obj.action === 'string' ? obj.action.trim() : '';
    if (!action) continue;
    const note = typeof obj.note === 'string' && obj.note.trim() ? obj.note.trim() : undefined;
    const step: ShotPlanStep = { index: cleaned.length + 1, action };
    if (note !== undefined) step.note = note;
    cleaned.push(step);
  }
  // Renumber 1-based regardless of what the model emitted, so the UI never has gaps.
  return cleaned.map((s, i) => ({ ...s, index: i + 1 }));
}

/** Strip the JSON code fence from assistant text for clean display. */
export function stripJsonBlock(text: string): string {
  return text.replace(/```json\s*[\s\S]*?```/, '').trim();
}

/**
 * Single shot-plan conversation, scoped to one (projectId, sceneId).
 * State is in-memory only — for persistence across server restarts, the routes
 * write `scene.shot_plan_chat` to `storyboard.yaml` at accept time.
 */
export class ShotPlanSession {
  readonly projectId: string;
  readonly sceneId: string;
  transcript: ShotPlanChatTurn[] = [];
  proposedSteps: ShotPlanStep[] = [];

  constructor(
    projectId: string,
    sceneId: string,
    hydrateTranscript?: ShotPlanChatTurn[],
  ) {
    this.projectId = projectId;
    this.sceneId = sceneId;
    if (hydrateTranscript && hydrateTranscript.length > 0) {
      this.transcript = [...hydrateTranscript];
    }
  }

  /** Append a turn. The id is generated for future use (logging, references); not exposed. */
  appendTurn(role: 'user' | 'assistant', content: string): ShotPlanChatTurn {
    const turn: ShotPlanChatTurn = {
      role,
      content,
      at: new Date().toISOString(),
    };
    this.transcript.push(turn);
    // randomUUID call kept for parity with Ideation — not stored, just future-proofing.
    void randomUUID();
    return turn;
  }
}

/** Manager keyed by `${projectId}:${sceneId}`. */
export class ShotPlanManager {
  private sessions = new Map<string, ShotPlanSession>();

  private key(projectId: string, sceneId: string): string {
    return `${projectId}:${sceneId}`;
  }

  getOrCreate(
    projectId: string,
    sceneId: string,
    hydrateTranscript?: ShotPlanChatTurn[],
  ): ShotPlanSession {
    const k = this.key(projectId, sceneId);
    let s = this.sessions.get(k);
    if (!s) {
      s = new ShotPlanSession(projectId, sceneId, hydrateTranscript);
      this.sessions.set(k, s);
    }
    return s;
  }

  get(projectId: string, sceneId: string): ShotPlanSession | undefined {
    return this.sessions.get(this.key(projectId, sceneId));
  }

  delete(projectId: string, sceneId: string): void {
    this.sessions.delete(this.key(projectId, sceneId));
  }
}
