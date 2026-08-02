import { ModelTaskRoleSchema, type ModelTaskRole } from '@vpa/shared';
import type { ProjectStore } from '../project/store.js';
import { projectFieldByRole } from './model-router.js';
import type { ModelRegistry } from './model-registry.js';

const MAX_PROJECT_REFERENCES = 50;

export interface ModelReferenceReport {
  globalRoles: ModelTaskRole[];
  projects: Array<{ id: string; name: string; roles: ModelTaskRole[] }>;
  truncated: boolean;
}

export type ModelReferenceWarning = (
  fields: Record<string, unknown>,
  message: string,
) => void;

export async function findModelReferences(
  entryId: string,
  registry: ModelRegistry,
  store: ProjectStore,
  warn?: ModelReferenceWarning,
): Promise<ModelReferenceReport> {
  const globalRoles = ModelTaskRoleSchema.options.filter(
    (role) => registry.getAssignment(role) === entryId,
  );
  const tracker = await store.readTracker();
  const projects: ModelReferenceReport['projects'] = [];
  let truncated = false;

  for (const trackerEntry of tracker.projects) {
    let project;
    try {
      project = await store.readProject(trackerEntry.id);
    } catch (error) {
      warn?.(
        { error, projectId: trackerEntry.id, projectName: trackerEntry.name },
        'Skipping unreadable project while scanning model references',
      );
      continue;
    }

    const roles = ModelTaskRoleSchema.options.filter(
      (role) => project.model_routing[projectFieldByRole[role]] === entryId,
    );
    if (roles.length === 0) continue;
    if (projects.length === MAX_PROJECT_REFERENCES) {
      truncated = true;
      break;
    }
    projects.push({ id: project.id, name: project.name, roles });
  }

  return { globalRoles, projects, truncated };
}
