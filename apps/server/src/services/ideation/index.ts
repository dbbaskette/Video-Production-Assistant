import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SceneSchema, type ProposalOperation, type Scene } from '@vpa/shared';
import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';

export interface IdeationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  scenes?: Scene[];
  timestamp: string;
}

export interface IdeationState {
  projectId: string;
  messages: IdeationMessage[];
  proposedScenes: Scene[];
}

/**
 * Parse scene proposals from an LLM response.
 * Looks for a JSON block fenced with ```json ... ``` containing a "scenes" array.
 */
export function parseScenesFromResponse(text: string): Scene[] {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[1]!.trim());
    if (parsed && Array.isArray(parsed.scenes)) {
      return parsed.scenes.map((s: Record<string, unknown>) => ({
        id: String(s.id ?? `scene-${randomUUID().slice(0, 8)}`),
        name: String(s.name ?? 'Untitled Scene'),
        description: String(s.description ?? ''),
        type: ['desktop', 'terminal', 'browser', 'slide'].includes(String(s.type))
          ? String(s.type)
          : 'desktop',
      })) as Scene[];
    }
  } catch {
    // JSON parse failed — no scenes extracted
  }
  return [];
}

/**
 * Strip the JSON code fence from assistant text for cleaner display.
 */
function stripJsonBlock(text: string): string {
  return text.replace(/```json\s*[\s\S]*?```/, '').trim();
}

/** Resolve the workspace root (two levels up from apps/server). */
function workspaceRoot(): string {
  return resolve(import.meta.dirname, '../../../../..');
}

export class IdeationSession {
  readonly projectId: string;
  messages: IdeationMessage[] = [];
  proposedScenes: Scene[] = [];

  constructor(projectId: string, initial?: Partial<IdeationState>) {
    this.projectId = projectId;
    this.messages = (initial?.messages ?? []).map((message) => ({ ...message, ...(message.scenes ? { scenes: message.scenes.map((scene) => ({ ...scene })) } : {}) }));
    this.proposedScenes = (initial?.proposedScenes ?? []).map((scene) => ({ ...scene }));
  }

  applyProposalOperation(operation: ProposalOperation): void {
    if (operation.type === 'add') {
      if (this.proposedScenes.some((scene) => scene.id === operation.scene.id)) throw new Error('Scene ID is already in use.');
      const index = Math.min(operation.index ?? this.proposedScenes.length, this.proposedScenes.length);
      this.proposedScenes = [...this.proposedScenes.slice(0, index), SceneSchema.parse(operation.scene), ...this.proposedScenes.slice(index)];
      return;
    }
    if (operation.type === 'update') {
      if (!this.proposedScenes.some((scene) => scene.id === operation.sceneId)) throw new Error('Proposed scene was not found.');
      this.proposedScenes = this.proposedScenes.map((scene) => scene.id === operation.sceneId ? SceneSchema.parse({ ...scene, ...operation.patch }) : scene);
      return;
    }
    if (operation.type === 'delete') {
      if (!this.proposedScenes.some((scene) => scene.id === operation.sceneId)) throw new Error('Proposed scene was not found.');
      this.proposedScenes = this.proposedScenes.filter((scene) => scene.id !== operation.sceneId);
      return;
    }
    const current = new Set(this.proposedScenes.map((scene) => scene.id));
    if (operation.sceneIds.length !== current.size || new Set(operation.sceneIds).size !== current.size || operation.sceneIds.some((id) => !current.has(id))) throw new Error('Reorder must contain every proposed scene exactly once.');
    const byId = new Map(this.proposedScenes.map((scene) => [scene.id, scene]));
    this.proposedScenes = operation.sceneIds.map((id) => byId.get(id)!);
  }

  async sendMessage(
    content: string,
    writer: LlmClient,
    objective?: string,
    /** When provided, project source-docs are prepended to the user prompt. */
    projectPath?: string,
    /** Independently routed general client used only for oversized source-doc compression. */
    general?: LlmClient,
  ): Promise<IdeationMessage> {
    // Keep the new turn in memory until both source preparation and writing
    // succeed. A routing/provider failure must not leave half a conversation.
    const userMsg: IdeationMessage = {
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };

    // Build the LLM prompt
    const systemPrompt = await loadPrompt(workspaceRoot(), 'ideation-system');

    // Build conversation context
    const historyContext = [...this.messages, userMsg]
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    const currentScenesContext = this.proposedScenes.length > 0
      ? `\n\nCurrent proposed scenes:\n${JSON.stringify(this.proposedScenes, null, 2)}`
      : '';

    const objectiveContext = objective ? `\n\nProject objective: ${objective}` : '';

    const baseUserPrompt = `${objectiveContext}${currentScenesContext}\n\nConversation:\n${historyContext}`;

    const { withReferenceContext } = await import('../project-source-docs/inject.js');
    const userPrompt = await withReferenceContext(baseUserPrompt, {
      projectPath,
      summarize: true,
      llm: general,
      strictSummarization: true,
    });

    // Call LLM
    const completion = await writer.complete({
      systemPrompt,
      userPrompt,
      temperature: 0.7,
    });

    // Parse scenes from response
    const scenes = parseScenesFromResponse(completion.text);
    if (scenes.length > 0) {
      this.proposedScenes = scenes;
    }

    // Create assistant message
    const assistantMsg: IdeationMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: stripJsonBlock(completion.text),
      scenes: scenes.length > 0 ? scenes : undefined,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(userMsg, assistantMsg);

    return assistantMsg;
  }

  getState(): IdeationState {
    return {
      projectId: this.projectId,
      messages: this.messages,
      proposedScenes: this.proposedScenes,
    };
  }
}

/**
 * Caches ideation sessions per project. Route handlers hydrate and persist the
 * session so a server restart does not discard the user's conversation or plan.
 */
export class IdeationManager {
  private sessions = new Map<string, IdeationSession>();

  getOrCreate(projectId: string, initial?: Partial<IdeationState>): IdeationSession {
    let session = this.sessions.get(projectId);
    if (!session) {
      session = new IdeationSession(projectId, initial);
      this.sessions.set(projectId, session);
    }
    return session;
  }

  get(projectId: string): IdeationSession | undefined {
    return this.sessions.get(projectId);
  }

  set(session: IdeationSession): void {
    this.sessions.set(session.projectId, session);
  }

  delete(projectId: string): void {
    this.sessions.delete(projectId);
  }
}
