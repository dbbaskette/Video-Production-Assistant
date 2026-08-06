import { describe, expect, it } from 'vitest';
import type { ProjectTrackerEntry } from '@vpa/shared';
import {
  filterAndSortProjects,
  normalizeProjectQuery,
  type ProjectSort,
} from './project-list-view.js';

const projects: ProjectTrackerEntry[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Zulu',
    path: '/Work/alpha-demo',
    lastOpened: '2026-08-01T12:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Alpha',
    path: '/Work/zulu-demo',
    lastOpened: '2026-08-03T12:00:00.000Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Missing',
    path: '/Work/missing',
    lastOpened: '2026-08-04T12:00:00.000Z',
    missing: true,
  },
];

describe('project list view model', () => {
  it('trims and folds project queries across names and paths', () => {
    expect(normalizeProjectQuery('  ALPHA  ')).toBe('alpha');
    expect(filterAndSortProjects(projects, 'ALPHA', 'recent').map((project) => project.id))
      .toEqual([projects[1]!.id, projects[0]!.id]);
  });

  it.each<[ProjectSort, string[]]>([
    ['recent', [projects[1]!.id, projects[0]!.id, projects[2]!.id]],
    ['name-asc', [projects[1]!.id, projects[0]!.id, projects[2]!.id]],
    ['name-desc', [projects[0]!.id, projects[1]!.id, projects[2]!.id]],
  ])('keeps missing entries last for %s sorting', (sort, expected) => {
    expect(filterAndSortProjects(projects, '', sort).map((project) => project.id))
      .toEqual(expected);
  });

  it('preserves tracker order when recent dates tie', () => {
    const tied = projects.slice(0, 2).map((project) => ({
      ...project,
      lastOpened: null,
    }));

    expect(filterAndSortProjects(tied, '', 'recent').map((project) => project.id))
      .toEqual([projects[0]!.id, projects[1]!.id]);
  });

  it('uses a stable tracker-order tie break for equal names', () => {
    const tied = projects.slice(0, 2).map((project) => ({ ...project, name: 'Same' }));
    expect(filterAndSortProjects(tied, '', 'name-asc').map((project) => project.id))
      .toEqual([projects[0]!.id, projects[1]!.id]);
  });
});
