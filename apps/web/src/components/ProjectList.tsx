/**
 * Dashboard project discovery and recent-project cleanup.
 *
 * Removing a project here is non-destructive: it only edits the tracker JSON
 * and never touches the project directory.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Search, X } from 'lucide-react';
import type { ProjectTrackerEntry } from '@vpa/shared';
import { api } from '../lib/api.js';
import { ProjectMediaSummary } from './ProjectMediaSummary.js';
import { relativeTime } from '../lib/format.js';
import {
  filterAndSortProjects,
  type ProjectSort,
} from '../lib/project-list-view.js';
import { useUi } from './ui/UiProvider.js';

interface Props {
  onOpen: (project: ProjectTrackerEntry) => void;
  onOpenFolder: () => void;
}

export function ProjectList({ onOpen, onOpenFolder }: Props) {
  const qc = useQueryClient();
  const ui = useUi();
  const [projectQuery, setProjectQuery] = useState('');
  const [projectSort, setProjectSort] = useState<ProjectSort>('recent');
  const query = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });

  const pruneMutation = useMutation({
    mutationFn: () => api.pruneMissingProjects(),
    onSuccess: ({ removed }) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      ui.showToast({
        message: `Removed ${removed.length} missing project${removed.length === 1 ? '' : 's'} from the list`,
        tone: 'success',
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.removeProjectFromTracker(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });

  const projects = query.data?.projects ?? [];
  const visibleProjects = useMemo(
    () => filterAndSortProjects(projects, projectQuery, projectSort),
    [projects, projectQuery, projectSort],
  );
  const missingCount = projects.filter((project) => project.missing).length;

  const resetFilters = () => {
    setProjectQuery('');
    setProjectSort('recent');
  };

  if (query.isLoading) {
    return <p style={{ color: 'var(--fg-muted)' }}>Loading projects…</p>;
  }
  if (query.isError) {
    return (
      <p style={{ color: 'var(--danger)' }}>
        Failed to load projects: {query.error instanceof Error ? query.error.message : 'unknown'}
      </p>
    );
  }

  return (
    <div className="project-list">
      <div className="project-list-toolbar" role="search" aria-label="Recent projects">
        <label className="project-list-search">
          <span className="project-list-toolbar__label">Find a project</span>
          <span className="project-list-search__field">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search recent projects"
              placeholder="Search name or folder"
              value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
            />
            {projectQuery && (
              <button
                type="button"
                className="project-list-search__clear"
                aria-label="Clear project search"
                title="Clear search"
                onClick={() => setProjectQuery('')}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </span>
        </label>

        <label className="project-list-sort">
          <span className="project-list-toolbar__label">Sort</span>
          <select
            aria-label="Sort recent projects"
            value={projectSort}
            onChange={(event) => setProjectSort(event.target.value as ProjectSort)}
          >
            <option value="recent">Recent</option>
            <option value="name-asc">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
          </select>
        </label>

        <output className="project-list-count" aria-live="polite">
          {projects.length === 0
            ? '0 projects'
            : `${visibleProjects.length} of ${projects.length} projects`}
        </output>

        <button type="button" className="project-list-open-folder" onClick={onOpenFolder}>
          <FolderOpen size={14} aria-hidden="true" />
          Open existing project…
        </button>
      </div>

      {missingCount > 0 && (
        <div className="project-list-missing-banner">
          <span>
            {missingCount} project{missingCount === 1 ? '' : 's'} no longer exist on disk.
          </span>
          <button
            type="button"
            onClick={async () => {
              const ok = await ui.confirm({
                title: `Clean up ${missingCount} missing project${missingCount === 1 ? '' : 's'}?`,
                body: 'Removes them from this list. The filesystem is not touched.',
                confirmLabel: 'Clean up',
              });
              if (ok) pruneMutation.mutate();
            }}
            disabled={pruneMutation.isPending}
            className="primary"
          >
            {pruneMutation.isPending ? 'Cleaning…' : `Clean up ${missingCount}`}
          </button>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty-state project-list-empty">
          No projects yet. Start with one of the options above, or open an existing folder.
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="empty-state project-list-empty">
          <strong>No projects match this search</strong>
          <span>Try another name or folder, or reset the project filters.</span>
          <button type="button" onClick={resetFilters}>Reset filters</button>
        </div>
      ) : (
        <ul className="project-list-cards">
          {visibleProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={onOpen}
              onRemove={async () => {
                const ok = await ui.confirm({
                  title: `Remove "${project.name}" from the list?`,
                  body: project.missing
                    ? 'The directory is already gone. This only clears the entry.'
                    : `The project directory at ${project.path} stays on disk; only the dashboard entry is removed. You can re-import it later with Open folder.`,
                  confirmLabel: 'Remove',
                  destructive: true,
                });
                if (ok) removeMutation.mutate(project.id);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onRemove,
}: {
  project: ProjectTrackerEntry;
  onOpen: (project: ProjectTrackerEntry) => void;
  onRemove: () => void;
}) {
  const details = (
    <>
      <span className="project-list-card__title-row">
        <span className="project-list-card__name">{project.name}</span>
        {project.missing && <span className="project-list-card__missing">Missing</span>}
      </span>
      {!project.missing && <ProjectMediaSummary projectId={project.id} compact />}
      <span className="project-list-card__time">
        {project.missing ? 'No longer on disk' : `Opened ${relativeTime(project.lastOpened)}`}
      </span>
    </>
  );

  return (
    <li className={`project-list-card${project.missing ? ' project-list-card--missing' : ''}`}>
      {project.missing ? (
        <div className="project-list-card__details">{details}</div>
      ) : (
        <a
          className="project-list-card__open"
          href={`/project/${project.id}`}
          aria-label={`Open ${project.name}`}
          onClick={(event) => {
            event.preventDefault();
            onOpen(project);
          }}
        >
          {details}
          <span className="project-list-card__affordance" aria-hidden="true">Open →</span>
        </a>
      )}
      <button
        type="button"
        className="project-list-card__remove"
        aria-label={`Remove ${project.name} from recent projects`}
        title="Remove from recent projects"
        onClick={onRemove}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}
