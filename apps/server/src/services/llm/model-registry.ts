/**
 * Model registry — persists configured model entries in ~/.vpa/models.json.
 *
 * Each entry represents a configured LLM provider + model + endpoint.
 * Exactly one entry is marked active at a time.
 */

import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../../lib/fs-atomic.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelProvider = 'fake' | 'gemini' | 'anthropic' | 'claude-code' | 'openai-compat';

export interface ModelEntry {
  id: string;
  name: string;           // display name, e.g. "Gemini Flash"
  provider: ModelProvider;
  model: string;          // model identifier sent to the API
  endpoint?: string;      // only for openai-compat
  apiKey?: string;        // stored locally — never sent to the browser
  active: boolean;
}

export interface ModelsFile {
  models: ModelEntry[];
}

// ---------------------------------------------------------------------------
// Seed defaults — built from env vars on first run
// ---------------------------------------------------------------------------

function seedFromEnv(env: NodeJS.ProcessEnv): ModelEntry[] {
  const entries: ModelEntry[] = [];

  // Always include fake
  entries.push({
    id: 'fake',
    name: 'Fake (deterministic)',
    provider: 'fake',
    model: 'fake',
    active: false,
  });

  if (env.GEMINI_API_KEY) {
    entries.push({
      id: 'gemini',
      name: 'Gemini',
      provider: 'gemini',
      model: env.GEMINI_MODEL || env.VPA_LLM_MODEL || 'gemini-2.5-flash-lite',
      apiKey: env.GEMINI_API_KEY,
      active: false,
    });
  }

  if (env.ANTHROPIC_API_KEY) {
    entries.push({
      id: 'anthropic',
      name: 'Anthropic',
      provider: 'anthropic',
      model: env.ANTHROPIC_MODEL || env.VPA_LLM_MODEL || 'claude-sonnet-4-20250514',
      apiKey: env.ANTHROPIC_API_KEY,
      active: false,
    });
  }

  // Claude Code — always available if the CLI is installed
  entries.push({
    id: 'claude-code',
    name: 'Claude Code (CLI)',
    provider: 'claude-code',
    model: env.CLAUDE_MODEL || 'sonnet',
    active: false,
  });

  // Mark the env-configured provider as active, or default to fake
  const envProvider = env.VPA_LLM_PROVIDER ?? 'fake';
  const activeEntry = entries.find((e) => e.provider === envProvider) ?? entries[0]!;
  activeEntry.active = true;

  return entries;
}

// ---------------------------------------------------------------------------
// Registry class
// ---------------------------------------------------------------------------

export class ModelRegistry {
  private filePath: string;
  private data: ModelsFile = { models: [] };

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = JSON.parse(raw) as ModelsFile;
      // Merge any new env-configured entries that don't exist yet
      this.mergeEnvEntries(env);
    } catch {
      // File doesn't exist yet — seed from env
      this.data = { models: seedFromEnv(env) };
      await this.save();
    }
  }

  /** Merge env-configured entries that are missing from the persisted file */
  private mergeEnvEntries(env: NodeJS.ProcessEnv): void {
    const existingIds = new Set(this.data.models.map((m) => m.id));
    const seeded = seedFromEnv(env);
    let changed = false;

    for (const entry of seeded) {
      if (!existingIds.has(entry.id)) {
        entry.active = false; // don't override the user's active choice
        this.data.models.push(entry);
        changed = true;
      }
    }

    // Update API keys from env if they changed
    for (const entry of this.data.models) {
      if (entry.provider === 'gemini' && env.GEMINI_API_KEY && entry.apiKey !== env.GEMINI_API_KEY) {
        entry.apiKey = env.GEMINI_API_KEY;
        changed = true;
      }
      if (entry.provider === 'anthropic' && env.ANTHROPIC_API_KEY && entry.apiKey !== env.ANTHROPIC_API_KEY) {
        entry.apiKey = env.ANTHROPIC_API_KEY;
        changed = true;
      }
    }

    if (changed) void this.save();
  }

  list(): Array<Omit<ModelEntry, 'apiKey'> & { hasApiKey: boolean }> {
    return this.data.models.map(({ apiKey, ...rest }) => ({
      ...rest,
      hasApiKey: !!apiKey,
    }));
  }

  getActive(): ModelEntry | undefined {
    return this.data.models.find((m) => m.active);
  }

  getById(id: string): ModelEntry | undefined {
    return this.data.models.find((m) => m.id === id);
  }

  async add(entry: Omit<ModelEntry, 'active'>): Promise<ModelEntry> {
    if (this.data.models.some((m) => m.id === entry.id)) {
      throw new Error(`Model "${entry.id}" already exists`);
    }
    const full: ModelEntry = { ...entry, active: this.data.models.length === 0 };
    this.data.models.push(full);
    await this.save();
    return full;
  }

  async update(id: string, patch: Partial<Omit<ModelEntry, 'id'>>): Promise<ModelEntry> {
    const entry = this.data.models.find((m) => m.id === id);
    if (!entry) throw new Error(`Model "${id}" not found`);
    Object.assign(entry, patch);
    await this.save();
    return entry;
  }

  async activate(id: string): Promise<ModelEntry> {
    const target = this.data.models.find((m) => m.id === id);
    if (!target) throw new Error(`Model "${id}" not found`);
    for (const m of this.data.models) m.active = false;
    target.active = true;
    await this.save();
    return target;
  }

  async remove(id: string): Promise<void> {
    const idx = this.data.models.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Model "${id}" not found`);
    const wasActive = this.data.models[idx]!.active;
    this.data.models.splice(idx, 1);
    // If we removed the active one, activate the first remaining
    if (wasActive && this.data.models.length > 0) {
      this.data.models[0]!.active = true;
    }
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteFile(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
  }
}
