import { readFile } from 'node:fs/promises';
import {
  OutputVariantDraftSchema,
  OutputVariantSchema,
  VariantStoreSchema,
  type OutputVariant,
  type OutputVariantDraft,
  type Project,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { projectFiles } from '../project/paths.js';

export class VariantStoreError extends Error {
  constructor(public readonly code: 'not_found' | 'conflict', message: string) {
    super(message);
  }
}

export class VariantStore {
  private tail = Promise.resolve();

  constructor(private readonly projectPath: string) {}

  private async readAll(): Promise<OutputVariant[]> {
    try {
      return VariantStoreSchema.parse(JSON.parse(await readFile(projectFiles(this.projectPath).variants, 'utf8'))).variants;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeAll(variants: OutputVariant[]): Promise<void> {
    await atomicWriteFile(projectFiles(this.projectPath).variants, JSON.stringify(VariantStoreSchema.parse({ version: 1, variants }), null, 2));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  list(): Promise<OutputVariant[]> { return this.readAll(); }

  async get(id: string): Promise<OutputVariant> {
    const variant = (await this.readAll()).find((item) => item.id === id);
    if (!variant) throw new VariantStoreError('not_found', 'Output variant not found.');
    return variant;
  }

  create(input: OutputVariantDraft, sourceRevision: number, project: Project): Promise<OutputVariant> {
    return this.serialize(async () => {
      const draft = OutputVariantDraftSchema.parse(input);
      const variants = await this.readAll();
      const existing = variants.find((item) => item.id === draft.id);
      if (existing) {
        const { id, name, aspect_ratio, crop, safe_area, selected_ranges, source_language, target_language, captions, replace_narration, narration_replacement } = existing;
        const comparable = { id, name, aspect_ratio, crop, safe_area, selected_ranges, source_language, target_language, captions, replace_narration, narration_replacement };
        if (JSON.stringify(comparable) === JSON.stringify(draft)) return existing;
        throw new VariantStoreError('conflict', 'This variant ID is already used by a different definition.');
      }
      const now = new Date().toISOString();
      const variant = OutputVariantSchema.parse({
        version: 1,
        ...draft,
        source_revision: sourceRevision,
        source_brand: project.brand,
        created_at: now,
        updated_at: now,
      });
      await this.writeAll([...variants, variant]);
      return variant;
    });
  }

  update(id: string, input: OutputVariantDraft, expectedUpdatedAt: string): Promise<OutputVariant> {
    return this.serialize(async () => {
      const draft = OutputVariantDraftSchema.parse(input);
      if (draft.id !== id) throw new VariantStoreError('conflict', 'Variant ID cannot be changed.');
      const variants = await this.readAll();
      const index = variants.findIndex((item) => item.id === id);
      if (index < 0) throw new VariantStoreError('not_found', 'Output variant not found.');
      if (variants[index]!.updated_at !== expectedUpdatedAt) throw new VariantStoreError('conflict', 'The variant changed since it was opened. Refresh and try again.');
      const updated = OutputVariantSchema.parse({ ...variants[index]!, ...draft, updated_at: new Date().toISOString() });
      variants[index] = updated;
      await this.writeAll(variants);
      return updated;
    });
  }

  rebase(id: string, sourceRevision: number, project: Project, expectedUpdatedAt: string): Promise<OutputVariant> {
    return this.serialize(async () => {
      const variants = await this.readAll();
      const index = variants.findIndex((item) => item.id === id);
      if (index < 0) throw new VariantStoreError('not_found', 'Output variant not found.');
      if (variants[index]!.updated_at !== expectedUpdatedAt) throw new VariantStoreError('conflict', 'The variant changed since it was opened. Refresh and try again.');
      const updated = OutputVariantSchema.parse({
        ...variants[index]!, source_revision: sourceRevision, source_brand: project.brand, updated_at: new Date().toISOString(),
      });
      variants[index] = updated;
      await this.writeAll(variants);
      return updated;
    });
  }

  remove(id: string, expectedUpdatedAt: string): Promise<void> {
    return this.serialize(async () => {
      const variants = await this.readAll();
      const existing = variants.find((item) => item.id === id);
      if (!existing) return;
      if (existing.updated_at !== expectedUpdatedAt) throw new VariantStoreError('conflict', 'The variant changed since it was opened. Refresh and try again.');
      await this.writeAll(variants.filter((item) => item.id !== id));
    });
  }
}
