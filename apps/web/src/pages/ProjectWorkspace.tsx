import { useParams, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { ProjectSidebar } from '../components/ProjectSidebar.js';
import { HealthRail } from '../components/HealthRail.js';

export function ProjectWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();

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
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)' }}>
      <ProjectSidebar projectName={project.name} />
      <main
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ flex: 1 }}>
          <Outlet context={{ project }} />
        </div>
        <HealthRail />
      </main>
    </div>
  );
}
