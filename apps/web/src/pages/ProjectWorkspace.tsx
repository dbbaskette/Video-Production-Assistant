import { useCallback, useState } from 'react';
import { useParams, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ProjectTrackerEntry } from '@vpa/shared';
import { api } from '../lib/api.js';
import { ProjectSidebar } from '../components/ProjectSidebar.js';
import { ProjectIssuesControl } from '../components/ProjectIssuesDrawer.js';
import {
  readWorkspacePreferences,
  writeWorkspacePreferences,
} from '../lib/workspace-preferences.js';

export interface WorkspaceOutletContext {
  project: ProjectTrackerEntry;
  projectNavCollapsed: boolean;
  setProjectNavCollapsed: (collapsed: boolean) => void;
  focusMode: boolean;
  setFocusMode: (focused: boolean) => void;
}

export function ProjectWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectNavCollapsed, setProjectNavCollapsedState] = useState(
    () => readWorkspacePreferences().projectNavCollapsed,
  );
  const [focusMode, setFocusMode] = useState(false);

  const setProjectNavCollapsed = useCallback((collapsed: boolean) => {
    setProjectNavCollapsedState(collapsed);
    writeWorkspacePreferences({ projectNavCollapsed: collapsed });
  }, []);

  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
  });

  if (isLoading) {
    return (
      <div style={{ padding: 40, color: 'var(--fg-muted)' }}>Loading project…</div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, color: 'var(--danger)' }}>
        Failed to load project: {error instanceof Error ? error.message : 'unknown'}
      </div>
    );
  }

  const project = data?.projects.find((p) => p.id === projectId);
  if (!project) {
    return (
      <div style={{ padding: 40, color: 'var(--danger)' }}>
        Project not found. <a href="/">Return to dashboard</a>
      </div>
    );
  }

  return (
    <div
      className={`project-workspace${focusMode ? ' project-workspace--focused' : ''}`}
      style={{ display: 'flex', height: 'calc(100vh - 52px)' }}
    >
      {!focusMode && (
        <ProjectSidebar
          projectName={project.name}
          collapsed={projectNavCollapsed}
          onCollapsedChange={setProjectNavCollapsed}
        />
      )}
      <main
        className="project-workspace__main"
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="project-workspace-tools">
          <ProjectIssuesControl projectId={project.id} />
        </div>
        <div style={{ flex: 1 }}>
          <Outlet
            context={{
              project,
              projectNavCollapsed,
              setProjectNavCollapsed,
              focusMode,
              setFocusMode,
            } satisfies WorkspaceOutletContext}
          />
        </div>
      </main>
    </div>
  );
}
