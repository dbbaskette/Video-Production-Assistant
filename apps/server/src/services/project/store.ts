import { readFile, mkdir, readdir } from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import {
  ProjectSchema,
  ProjectTrackerSchema,
  type Project,
  type ProjectTracker,
  type ProjectTrackerEntry,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { dumpYaml, loadYaml } from '../../lib/yaml.js';
import { projectFiles, resolveProjectRoot, trackerPath } from './paths.js';

export interface ProjectStoreOptions {
  vpaHome: string;
  projectsDefault: string;
}

export interface CreateProjectInput {
  name: string;
  parentDir?: string;
  objective?: string;
  audience?: string;
  brand?: { id: string; applied_version: number } | null;
}

export class ProjectStore {
  constructor(private readonly opts: ProjectStoreOptions) {}

  async readTracker(): Promise<ProjectTracker> {
    const p = trackerPath(this.opts.vpaHome);
    let text: string;
    try {
      text = await readFile(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, projects: [] };
      }
      throw err;
    }
    return ProjectTrackerSchema.parse(JSON.parse(text));
  }

  private async writeTracker(tracker: ProjectTracker): Promise<void> {
    const p = trackerPath(this.opts.vpaHome);
    await atomicWriteFile(p, JSON.stringify(tracker, null, 2));
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const parent = input.parentDir ?? this.opts.projectsDefault;
    const root = resolveProjectRoot(parent, input.name);

    // tracker dup check first: gives a precise error before touching the FS
    const tracker = await this.readTracker();
    if (tracker.projects.some((p) => p.name === input.name)) {
      throw new Error(`Project with name "${input.name}" already exists in tracker`);
    }

    // ensure root does not already contain content
    try {
      const entries = await readdir(root);
      if (entries.length > 0) {
        throw new Error(`Project root ${root} is not empty`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // ENOENT is fine — we'll create it
    }
    await mkdir(root, { recursive: true });

    const project: Project = ProjectSchema.parse({
      id: uuidv4(),
      name: input.name,
      path: root,
      created: new Date().toISOString(),
      objective: input.objective,
      audience: input.audience,
      brand: input.brand ?? null,
    });

    const files = projectFiles(root);
    await atomicWriteFile(files.metadata, dumpYaml(project));

    const entry: ProjectTrackerEntry = {
      id: project.id,
      name: project.name,
      path: project.path,
      lastOpened: project.created,
    };
    await this.writeTracker({ version: 1, projects: [...tracker.projects, entry] });

    return project;
  }

  async import(projectRoot: string): Promise<Project> {
    const files = projectFiles(projectRoot);
    let text: string;
    try {
      text = await readFile(files.metadata, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`No project.yaml found at ${files.metadata}`);
      }
      throw err;
    }
    const project = loadYaml(text, ProjectSchema);

    const tracker = await this.readTracker();
    const existingIndex = tracker.projects.findIndex((p) => p.id === project.id);
    const entry: ProjectTrackerEntry = {
      id: project.id,
      name: project.name,
      path: projectRoot,
      lastOpened: new Date().toISOString(),
    };
    const updated =
      existingIndex >= 0
        ? tracker.projects.map((p, i) => (i === existingIndex ? entry : p))
        : [...tracker.projects, entry];
    await this.writeTracker({ version: 1, projects: updated });

    if (project.path !== projectRoot) {
      const corrected: Project = { ...project, path: projectRoot };
      await atomicWriteFile(files.metadata, dumpYaml(corrected));
      return corrected;
    }
    return project;
  }

  async touch(id: string): Promise<void> {
    const tracker = await this.readTracker();
    const next = tracker.projects.map((p) =>
      p.id === id ? { ...p, lastOpened: new Date().toISOString() } : p,
    );
    await this.writeTracker({ version: 1, projects: next });
  }

  /** Read full project metadata (project.yaml) by id. */
  async readProject(id: string): Promise<Project> {
    const tracker = await this.readTracker();
    const entry = tracker.projects.find((p) => p.id === id);
    if (!entry) throw new Error(`Project not found: ${id}`);
    const files = projectFiles(entry.path);
    const text = await readFile(files.metadata, 'utf8');
    return loadYaml(text, ProjectSchema);
  }

  /** Update the brand applied to a project. Pass null to clear. */
  async setProjectBrand(
    id: string,
    brand: { id: string; applied_version: number } | null,
  ): Promise<Project> {
    const tracker = await this.readTracker();
    const entry = tracker.projects.find((p) => p.id === id);
    if (!entry) throw new Error(`Project not found: ${id}`);
    const files = projectFiles(entry.path);
    const text = await readFile(files.metadata, 'utf8');
    const current = loadYaml(text, ProjectSchema);
    const updated: Project = ProjectSchema.parse({ ...current, brand });
    await atomicWriteFile(files.metadata, dumpYaml(updated));
    return updated;
  }
}
