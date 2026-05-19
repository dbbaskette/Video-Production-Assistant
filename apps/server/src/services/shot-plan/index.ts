import { resolve } from 'node:path';
import type { Scene } from '@vpa/shared';
import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';

function workspaceRoot(): string {
  return resolve(import.meta.dirname, '../../../../..');
}

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
    const step: ShotPlanStep = { index: 0, action }; // index assigned by the final renumbering pass
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

  appendTurn(role: 'user' | 'assistant', content: string): ShotPlanChatTurn {
    const turn: ShotPlanChatTurn = {
      role,
      content,
      at: new Date().toISOString(),
    };
    this.transcript.push(turn);
    return turn;
  }

  async sendMessage(
    content: string,
    llm: LlmClient,
    scene: Pick<Scene, 'id' | 'name' | 'description' | 'type'> & {
      intent?: string;
    },
    project: { objective?: string; audience?: string; sourceDocs?: string[] },
  ): Promise<ShotPlanChatTurn> {
    this.appendTurn('user', content);

    const systemPrompt = await loadPrompt(workspaceRoot(), 'scene-shot-plan');

    const sceneContext =
      `Scene name: ${scene.name}\n` +
      `Scene type: ${scene.type}\n` +
      `Scene description: ${scene.description}` +
      (scene.intent ? `\nUser intent: ${scene.intent}` : '');

    const projectContext =
      (project.objective ? `Project objective: ${project.objective}\n` : '') +
      (project.audience ? `Audience: ${project.audience}\n` : '') +
      (project.sourceDocs && project.sourceDocs.length > 0
        ? `Project source docs: ${project.sourceDocs.join(', ')}\n`
        : '');

    const historyContext = this.transcript
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n\n');

    const currentStepsContext =
      this.proposedSteps.length > 0
        ? `\n\nCurrent proposed steps:\n${JSON.stringify({ steps: this.proposedSteps }, null, 2)}`
        : '';

    const userPrompt =
      `${sceneContext}\n\n${projectContext}\nConversation:\n${historyContext}${currentStepsContext}`;

    const completion = await llm.complete({
      systemPrompt,
      userPrompt,
      temperature: 0.4,
    });

    const steps = parseStepsFromResponse(completion.text);
    if (steps.length > 0) {
      this.proposedSteps = steps;
    }

    return this.appendTurn('assistant', stripJsonBlock(completion.text));
  }
}

/** Manager keyed by `${projectId}:${sceneId}`. */
export class ShotPlanManager {
  private sessions = new Map<string, ShotPlanSession>();

  // Safe today because projectId is UUID-shaped and sceneId follows the `scene-<8-hex>` slug pattern;
  // re-encode if either ever permits a literal `:`.
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
