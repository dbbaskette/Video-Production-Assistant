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

export const ModelEntrySchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  provider: ModelProviderSchema,
  model: z.string().min(1).max(500),
  endpoint: z.string().max(2_048).optional(),
  apiKey: z.string().max(20_000).optional(),
}).strict();

export const ModelEntryUpdateSchema = ModelEntrySchema
  .omit({ id: true, provider: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one editable model field is required.',
  });
export type ModelEntryUpdate = z.infer<typeof ModelEntryUpdateSchema>;

const AssignmentSchema = z.object({
  'video-understanding': z.string().min(1).max(200).optional(),
  writing: z.string().min(1).max(200).optional(),
  general: z.string().min(1).max(200).optional(),
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

export type ModelRegistryErrorCode =
  | 'invalid_model'
  | 'invalid_assignment'
  | 'model_exists'
  | 'model_not_found'
  | 'persistence_failed';

export class ModelRegistryError extends Error {
  constructor(
    readonly code: ModelRegistryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelRegistryError';
  }
}

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

function cloneModelsFile(data: ModelsFile): ModelsFile {
  return Version2ModelsFileSchema.parse({
    version: 2,
    models: data.models.map((entry) => ({ ...entry })),
    assignments: { ...data.assignments },
  });
}

function mergeEnvEntries(
  current: ModelsFile,
  env: NodeJS.ProcessEnv,
): { candidate: ModelsFile; changed: boolean } {
  const candidate = cloneModelsFile(current);
  const existingIds = new Set(candidate.models.map((entry) => entry.id));
  const seeded = seedFromEnv(env);
  const seededById = new Map(seeded.map((entry) => [entry.id, entry] as const));
  let changed = false;

  for (const entry of seeded) {
    if (!existingIds.has(entry.id)) {
      candidate.models.push(entry);
      changed = true;
    }
  }

  for (const entry of candidate.models) {
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

  return { candidate: Version2ModelsFileSchema.parse(candidate), changed };
}

export class ModelRegistry {
  private data: ModelsFile = { version: 2, models: [], assignments: {} };
  private mutationQueue: Promise<void> = Promise.resolve();

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
      const candidate = initialDataFromEnv(env);
      await this.persistCandidate(candidate);
      this.data = candidate;
      return;
    }

    const parsed = DiskModelsFileSchema.parse(JSON.parse(raw));
    const migrated = parsed.version === 2 ? parsed : migrateLegacy(parsed);
    const merged = mergeEnvEntries(migrated, env);
    // A valid v2 catalog is already the durable source of truth. Publish that
    // exact disk state before attempting optional environment enrichment so a
    // failed enrichment save cannot make runtime assignments disappear.
    if (parsed.version === 2) this.data = cloneModelsFile(parsed);
    if (parsed.version !== 2 || merged.changed) {
      await this.persistCandidate(merged.candidate);
    }
    this.data = merged.candidate;
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
    const entry = this.data.models.find((candidate) => candidate.id === id);
    return entry ? { ...entry } : undefined;
  }

  getAssignment(role: ModelTaskRole): string | undefined {
    return this.data.assignments[role];
  }

  getAssignments(): Partial<Record<ModelTaskRole, string>> {
    return { ...this.data.assignments };
  }

  async setAssignments(patch: Partial<Record<ModelTaskRole, string | null>>): Promise<void> {
    await this.mutate((candidate) => {
      for (const id of Object.values(patch)) {
        if (id !== null && id !== undefined && !candidate.models.some((entry) => entry.id === id)) {
          throw new ModelRegistryError('invalid_assignment', 'The assignment references an unknown model.');
        }
      }
      for (const [role, id] of Object.entries(patch) as Array<[ModelTaskRole, string | null | undefined]>) {
        if (id === null) delete candidate.assignments[role];
        else if (id !== undefined) candidate.assignments[role] = id;
      }
      return { candidate, result: undefined };
    });
  }

  async add(entry: ModelEntry): Promise<ModelEntry> {
    const parsed = this.parseEntry(entry);
    return this.mutate((candidate) => {
      if (candidate.models.some((existing) => existing.id === parsed.id)) {
        throw new ModelRegistryError('model_exists', 'A model with this ID already exists.');
      }
      candidate.models.push({ ...parsed });
      return { candidate, result: { ...parsed } };
    });
  }

  async update(id: string, patch: ModelEntryUpdate): Promise<ModelEntry> {
    const parsedPatch = this.parseUpdate(patch);
    return this.mutate((candidate) => {
      const index = candidate.models.findIndex((entry) => entry.id === id);
      if (index === -1) {
        throw new ModelRegistryError('model_not_found', 'Model configuration was not found.');
      }
      const updated = this.parseEntry({ ...candidate.models[index]!, ...parsedPatch });
      candidate.models[index] = updated;
      return { candidate, result: { ...updated } };
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((candidate) => {
      const index = candidate.models.findIndex((entry) => entry.id === id);
      if (index === -1) {
        throw new ModelRegistryError('model_not_found', 'Model configuration was not found.');
      }
      candidate.models.splice(index, 1);
      for (const [role, assignedId] of Object.entries(candidate.assignments) as Array<[ModelTaskRole, string]>) {
        if (assignedId === id) delete candidate.assignments[role];
      }
      return { candidate, result: undefined };
    });
  }

  private parseEntry(entry: unknown): ModelEntry {
    const parsed = ModelEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new ModelRegistryError('invalid_model', 'Model configuration is invalid.');
    }
    return parsed.data;
  }

  private parseUpdate(patch: unknown): ModelEntryUpdate {
    const parsed = ModelEntryUpdateSchema.safeParse(patch);
    if (!parsed.success) {
      throw new ModelRegistryError('invalid_model', 'Model configuration update is invalid.');
    }
    return parsed.data;
  }

  private mutate<T>(
    build: (candidate: ModelsFile) => { candidate: ModelsFile; result: T },
  ): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      const outcome = build(cloneModelsFile(this.data));
      const candidate = Version2ModelsFileSchema.parse(outcome.candidate);
      await this.persistCandidate(candidate);
      this.data = candidate;
      return outcome.result;
    });
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persistCandidate(candidate: ModelsFile): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await this.persist(this.filePath, JSON.stringify(candidate, null, 2) + '\n');
    } catch (error) {
      throw new ModelRegistryError(
        'persistence_failed',
        'Model settings could not be saved.',
        { cause: error },
      );
    }
  }
}
