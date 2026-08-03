/**
 * Model registry — persists configured model entries in ~/.vpa/models.json.
 *
 * Version 2 stores role assignments separately from the configured catalog.
 */

import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  ModelProviderSchema,
  type ModelCapabilities,
  type ModelTaskRole,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { capabilitiesForProvider, configuredReadiness } from './factory.js';

export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export interface ModelEntry {
  id: string;
  name: string;
  provider: ModelProvider;
  model: string;
  endpoint?: string;
  apiKey?: string;
}

export interface ModelsFile {
  version: 2;
  models: ModelEntry[];
  assignments: Partial<Record<ModelTaskRole, string>>;
}

export interface SanitizedModelEntry extends Omit<ModelEntry, 'apiKey'> {
  hasApiKey: boolean;
  capabilities: ModelCapabilities;
  ready: boolean;
  readinessMessage?: string;
}

const ModelEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: ModelProviderSchema,
  model: z.string(),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
}).strict();

const AssignmentSchema = z.object({
  'video-understanding': z.string().optional(),
  writing: z.string().optional(),
  general: z.string().optional(),
}).strict();

const Version2ModelsFileSchema = z.object({
  version: z.literal(2),
  models: z.array(ModelEntrySchema),
  assignments: AssignmentSchema,
}).strict();

const LegacyModelEntrySchema = ModelEntrySchema.extend({ active: z.boolean().optional() });

const LegacyModelsFileSchema = z.object({
  version: z.literal(1).optional(),
  models: z.array(LegacyModelEntrySchema),
}).passthrough();

const DiskModelsFileSchema = z.union([Version2ModelsFileSchema, LegacyModelsFileSchema]);

type LegacyModelsFile = z.infer<typeof LegacyModelsFileSchema>;

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function seedFromEnv(env: NodeJS.ProcessEnv): ModelEntry[] {
  const entries: ModelEntry[] = [
    { id: 'fake', name: 'Fake (deterministic)', provider: 'fake', model: 'fake' },
  ];

  if (env.GEMINI_API_KEY) {
    entries.push({
      id: 'gemini',
      name: 'Gemini',
      provider: 'gemini',
      model: env.GEMINI_MODEL || env.VPA_LLM_MODEL || 'gemini-2.5-flash-lite',
      apiKey: env.GEMINI_API_KEY,
    });
  }

  if (env.ANTHROPIC_API_KEY) {
    entries.push({
      id: 'anthropic',
      name: 'Anthropic',
      provider: 'anthropic',
      model: env.ANTHROPIC_MODEL || env.VPA_LLM_MODEL || 'claude-sonnet-4-20250514',
      apiKey: env.ANTHROPIC_API_KEY,
    });
  }

  entries.push(
    { id: 'claude-code', name: 'Claude Code (CLI)', provider: 'claude-code', model: env.CLAUDE_MODEL || 'sonnet' },
    { id: 'codex-cli', name: 'Codex CLI', provider: 'codex-cli', model: env.CODEX_MODEL || 'default' },
  );

  return entries;
}

function initialDataFromEnv(env: NodeJS.ProcessEnv): ModelsFile {
  const models = seedFromEnv(env);
  const textProvider = env.VPA_LLM_PROVIDER ?? 'fake';
  const textEntry = models.find((entry) => entry.provider === textProvider) ?? models[0]!;
  const videoEntry = models.find((entry) =>
    entry.provider === 'gemini' && configuredReadiness(entry).ready,
  );

  return {
    version: 2,
    models,
    assignments: {
      writing: textEntry.id,
      general: textEntry.id,
      ...(videoEntry ? { 'video-understanding': videoEntry.id } : {}),
    },
  };
}

function migrateLegacy(legacy: LegacyModelsFile): ModelsFile {
  const models = legacy.models.map(({ active: _active, ...entry }) => entry);
  const previouslyActive = legacy.models.find((entry) => entry.active);
  const readyGemini = models.find((entry) =>
    entry.provider === 'gemini' && configuredReadiness(entry).ready,
  );

  return {
    version: 2,
    models,
    assignments: {
      ...(previouslyActive ? { writing: previouslyActive.id, general: previouslyActive.id } : {}),
      ...(readyGemini ? { 'video-understanding': readyGemini.id } : {}),
    },
  };
}

export class ModelRegistry {
  private data: ModelsFile = { version: 2, models: [], assignments: {} };

  constructor(
    private readonly filePath: string,
    private readonly persist: typeof atomicWriteFile = atomicWriteFile,
  ) {}

  async load(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      this.data = initialDataFromEnv(env);
      await this.save();
      return;
    }

    const parsed = DiskModelsFileSchema.parse(JSON.parse(raw));
    if (parsed.version === 2) {
      this.data = parsed;
    } else {
      this.data = migrateLegacy(parsed);
      await this.save();
    }
    await this.mergeEnvEntries(env);
  }

  private async mergeEnvEntries(env: NodeJS.ProcessEnv): Promise<void> {
    const existingIds = new Set(this.data.models.map((entry) => entry.id));
    const seeded = seedFromEnv(env);
    const seededById = new Map(seeded.map((entry) => [entry.id, entry] as const));
    let changed = false;

    for (const entry of seeded) {
      if (!existingIds.has(entry.id)) {
        this.data.models.push(entry);
        changed = true;
      }
    }

    for (const entry of this.data.models) {
      const fromEnv = seededById.get(entry.id);
      if (!fromEnv) continue;
      if (entry.model !== fromEnv.model) {
        entry.model = fromEnv.model;
        changed = true;
      }
      if (fromEnv.apiKey && entry.apiKey !== fromEnv.apiKey) {
        entry.apiKey = fromEnv.apiKey;
        changed = true;
      }
    }

    if (changed) await this.save();
  }

  list(): SanitizedModelEntry[] {
    return this.data.models.map(({ apiKey, ...entry }) => {
      const readiness = configuredReadiness({ ...entry, apiKey });
      return {
        ...entry,
        hasApiKey: Boolean(apiKey),
        capabilities: capabilitiesForProvider(entry.provider),
        ready: readiness.ready,
        ...(readiness.message ? { readinessMessage: readiness.message } : {}),
      };
    });
  }

  getById(id: string): ModelEntry | undefined {
    return this.data.models.find((entry) => entry.id === id);
  }

  getAssignment(role: ModelTaskRole): string | undefined {
    return this.data.assignments[role];
  }

  getAssignments(): Partial<Record<ModelTaskRole, string>> {
    return { ...this.data.assignments };
  }

  async setAssignments(patch: Partial<Record<ModelTaskRole, string | null>>): Promise<void> {
    for (const id of Object.values(patch)) {
      if (id !== null && id !== undefined && !this.getById(id)) {
        throw new Error(`Model "${id}" not found`);
      }
    }

    const assignments = { ...this.data.assignments };
    for (const [role, id] of Object.entries(patch) as Array<[ModelTaskRole, string | null | undefined]>) {
      if (id === null) delete assignments[role];
      else if (id !== undefined) assignments[role] = id;
    }
    this.data.assignments = assignments;
    await this.save();
  }

  async add(entry: ModelEntry): Promise<ModelEntry> {
    if (this.getById(entry.id)) throw new Error(`Model "${entry.id}" already exists`);
    this.data.models.push(entry);
    await this.save();
    return entry;
  }

  async update(id: string, patch: Partial<Omit<ModelEntry, 'id'>>): Promise<ModelEntry> {
    const entry = this.getById(id);
    if (!entry) throw new Error(`Model "${id}" not found`);
    Object.assign(entry, patch);
    await this.save();
    return entry;
  }

  async remove(id: string): Promise<void> {
    const index = this.data.models.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error(`Model "${id}" not found`);
    this.data.models.splice(index, 1);
    for (const [role, assignedId] of Object.entries(this.data.assignments) as Array<[ModelTaskRole, string]>) {
      if (assignedId === id) delete this.data.assignments[role];
    }
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.persist(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
  }
}
