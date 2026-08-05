import type { ModelTaskRole, Project } from '@vpa/shared';
import type { ProjectStore } from '../project/store.js';
import {
  findModelReferences,
  type ModelReferenceReport,
  type ModelReferenceWarning,
} from './model-references.js';
import {
  ModelRegistryError,
  type ModelRegistry,
} from './model-registry.js';

type AssignmentPatch = Partial<Record<ModelTaskRole, string | null>>;

export type ModelRoutingCoordinatorErrorCode = 'project_not_found';

export class ModelRoutingCoordinatorError extends Error {
  constructor(readonly code: ModelRoutingCoordinatorErrorCode, message: string) {
    super(message);
    this.name = 'ModelRoutingCoordinatorError';
  }
}

export interface ModelRoutingCoordinatorOptions {
  registry: ModelRegistry;
  store: ProjectStore;
  warn?: ModelReferenceWarning;
  findReferences?: typeof findModelReferences;
}

/**
 * One in-process serialization boundary for every operation that can create
 * or invalidate a model reference. The reference scan and delete therefore
 * observe the same acknowledged ordering as global and project assignments.
 */
export class ModelRoutingCoordinator {
  private readonly registry: ModelRegistry;
  private readonly store: ProjectStore;
  private readonly warn?: ModelReferenceWarning;
  private readonly findReferences: typeof findModelReferences;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ModelRoutingCoordinatorOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.warn = options.warn;
    this.findReferences = options.findReferences ?? findModelReferences;
  }

  setGlobalAssignments(patch: AssignmentPatch): Promise<void> {
    return this.serialize(() => this.registry.setAssignments(patch));
  }

  setProjectAssignments(projectId: string, patch: AssignmentPatch): Promise<Project> {
    return this.serialize(async () => {
      this.assertKnownModels(patch);
      const tracker = await this.store.readTracker();
      if (!tracker.projects.some((project) => project.id === projectId)) {
        throw new ModelRoutingCoordinatorError('project_not_found', 'Project was not found.');
      }
      return this.store.setProjectModelRouting(projectId, patch);
    });
  }

  /** Returns references when deletion is blocked, otherwise removes and returns null. */
  deleteModel(entryId: string): Promise<ModelReferenceReport | null> {
    return this.serialize(async () => {
      if (!this.registry.getById(entryId)) {
        throw new ModelRegistryError('model_not_found', 'Model configuration was not found.');
      }
      const references = await this.findReferences(
        entryId,
        this.registry,
        this.store,
        this.warn,
      );
      if (references.globalRoles.length > 0 || references.projects.length > 0) {
        return references;
      }
      await this.registry.remove(entryId);
      return null;
    });
  }

  private assertKnownModels(patch: AssignmentPatch): void {
    for (const entryId of Object.values(patch)) {
      if (entryId !== null && entryId !== undefined && !this.registry.getById(entryId)) {
        throw new ModelRegistryError(
          'invalid_assignment',
          'The assignment references an unknown model.',
        );
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.then(operation, operation);
    this.queue = current.then(() => undefined, () => undefined);
    return current;
  }
}
