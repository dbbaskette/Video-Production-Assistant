import { NavLink, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { storyboardApi } from '../lib/api.js';

const linkStyle = (isActive: boolean): React.CSSProperties => ({
  display: 'block',
  padding: '8px 16px',
  borderRadius: 6,
  color: isActive ? 'var(--accent)' : 'var(--fg)',
  background: isActive ? 'var(--accent-bg)' : 'transparent',
  textDecoration: 'none',
  fontSize: 14,
  fontWeight: isActive ? 600 : 400,
  marginBottom: 2,
});

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
  letterSpacing: 1,
  padding: '16px 16px 6px',
  margin: 0,
};

interface Props {
  projectName: string;
}

export function ProjectSidebar({ projectName }: Props) {
  const { projectId } = useParams<{ projectId: string }>();

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const scenes = storyboard?.scenes ?? [];

  return (
    <nav
      style={{
        width: 240,
        minWidth: 240,
        background: 'var(--bg-elev)',
        borderRight: '1px solid var(--border)',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Project name */}
      <div
        style={{
          padding: '20px 16px 12px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {projectName}
        </div>
      </div>

      {/* Main nav */}
      <div style={{ flex: 1, overflow: 'auto', paddingTop: 8 }}>
        <NavLink to={`/project/${projectId}`} end style={({ isActive }) => linkStyle(isActive)}>
          Overview
        </NavLink>
        <NavLink to={`/project/${projectId}/ideation`} style={({ isActive }) => linkStyle(isActive)}>
          Ideation
        </NavLink>
        <NavLink to={`/project/${projectId}/storyboard`} style={({ isActive }) => linkStyle(isActive)}>
          Storyboard
        </NavLink>
        <NavLink to={`/project/${projectId}/review`} style={({ isActive }) => linkStyle(isActive)}>
          Quality Review
        </NavLink>

        {/* Scene list */}
        {scenes.length > 0 && (
          <>
            <p style={sectionLabel}>Scenes</p>
            {scenes.map((scene) => (
              <NavLink
                key={scene.id}
                to={`/project/${projectId}/scene/${scene.id}`}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 16px 4px 28px',
                  fontSize: 13,
                  color: isActive ? 'var(--accent)' : 'var(--fg-muted)',
                  background: isActive ? 'var(--accent-bg)' : 'transparent',
                  textDecoration: 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  borderRadius: 4,
                })}
                title={scene.description}
              >
                {scene.recording && (
                  <span style={{ fontSize: 10, opacity: 0.7 }}>📹</span>
                )}
                {scene.name}
              </NavLink>
            ))}
          </>
        )}

        {/* Library section */}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 4 }}>
          <p style={sectionLabel}>Library</p>
          <NavLink to="/brands/new" style={({ isActive }) => linkStyle(isActive)}>
            Brands
          </NavLink>
        </div>
      </div>

      {/* Back to all projects */}
      <div style={{ borderTop: '1px solid var(--border)', padding: 8 }}>
        <NavLink
          to="/"
          style={{
            display: 'block',
            padding: '8px 16px',
            color: 'var(--fg-muted)',
            textDecoration: 'none',
            fontSize: 13,
          }}
        >
          ← All projects
        </NavLink>
      </div>
    </nav>
  );
}
