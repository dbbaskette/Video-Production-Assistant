import { readFile } from 'node:fs/promises';
import { ProjectTrackerSchema, type ProjectTracker } from '@vpa/shared';
import { trackerPath } from './paths.js';

export interface ProjectStoreOptions {
  vpaHome: string;
  projectsDefault: string;
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
    const raw = JSON.parse(text);
    return ProjectTrackerSchema.parse(raw);
  }
}
