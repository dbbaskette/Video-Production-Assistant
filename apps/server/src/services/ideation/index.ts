import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Scene } from '@vpa/shared';
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

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  async sendMessage(content: string, llm: LlmClient, objective?: string): Promise<IdeationMessage> {
    // Add user message
    const userMsg: IdeationMessage = {
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(userMsg);

    // Build the LLM prompt
    const systemPrompt = await loadPrompt(workspaceRoot(), 'ideation-system');

    // Build conversation context
    const historyContext = this.messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    const currentScenesContext = this.proposedScenes.length > 0
      ? `\n\nCurrent proposed scenes:\n${JSON.stringify(this.proposedScenes, null, 2)}`
      : '';

    const objectiveContext = objective ? `\n\nProject objective: ${objective}` : '';

    const userPrompt = `${objectiveContext}${currentScenesContext}\n\nConversation:\n${historyContext}`;

    // Call LLM
    const completion = await llm.complete({
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
    this.messages.push(assistantMsg);

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
 * Manages ideation sessions per project. Sessions are in-memory only.
 */
export class IdeationManager {
  private sessions = new Map<string, IdeationSession>();

  getOrCreate(projectId: string): IdeationSession {
    let session = this.sessions.get(projectId);
    if (!session) {
      session = new IdeationSession(projectId);
      this.sessions.set(projectId, session);
    }
    return session;
  }

  get(projectId: string): IdeationSession | undefined {
    return this.sessions.get(projectId);
  }

  delete(projectId: string): void {
    this.sessions.delete(projectId);
  }
}
