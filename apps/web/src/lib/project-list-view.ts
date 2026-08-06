import type { ProjectTrackerEntry } from '@vpa/shared';

export type ProjectSort = 'recent' | 'name-asc' | 'name-desc';

export function normalizeProjectQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function filterAndSortProjects(
  projects: readonly ProjectTrackerEntry[],
  query: string,
  sort: ProjectSort,
): ProjectTrackerEntry[] {
  const normalizedQuery = normalizeProjectQuery(query);

  return projects
    .map((project, trackerIndex) => ({ project, trackerIndex }))
    .filter(({ project }) => (
      normalizedQuery.length === 0
      || project.name.toLocaleLowerCase().includes(normalizedQuery)
      || project.path.toLocaleLowerCase().includes(normalizedQuery)
    ))
    .sort((a, b) => {
      const missingDelta = Number(!!a.project.missing) - Number(!!b.project.missing);
      if (missingDelta !== 0) return missingDelta;

      if (sort === 'recent') {
        const aTime = Date.parse(a.project.lastOpened ?? '') || 0;
        const bTime = Date.parse(b.project.lastOpened ?? '') || 0;
        return bTime - aTime || a.trackerIndex - b.trackerIndex;
      }

      const nameDelta = a.project.name.localeCompare(b.project.name, undefined, {
        sensitivity: 'base',
      });
      const directedDelta = sort === 'name-asc' ? nameDelta : -nameDelta;
      return directedDelta || a.trackerIndex - b.trackerIndex;
    })
    .map(({ project }) => project);
}
