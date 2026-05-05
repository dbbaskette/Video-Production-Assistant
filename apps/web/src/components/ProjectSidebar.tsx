import { Link, NavLink, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, brandsApi } from '../lib/api.js';

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

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: !!projectId,
  });

  const { data: brandRegistry } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });

  const appliedBrandId = project?.brand?.id ?? null;
  const appliedBrand = brandRegistry?.brands.find((b) => b.id === appliedBrandId) ?? null;

  return (
    <nav
      style={{
        width: 240,
        minWidth: 240,
        background: 'var(--bg-elev)',
        borderRight: '1px solid var(--border)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Project name + applied brand */}
      <div
        style={{
          padding: '20px 16px 12px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {projectName}
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ textTransform: 'uppercase', letterSpacing: 1 }}>Brand:</span>
          {appliedBrand ? (
            <Link
              to={`/brands/${appliedBrand.id}`}
              style={{
                color: 'var(--fg)',
                textDecoration: 'none',
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={`${appliedBrand.name} (v${project?.brand?.applied_version ?? appliedBrand.version})`}
            >
              {appliedBrand.name}
            </Link>
          ) : (
            <Link
              to={`/project/${projectId}#brand`}
              style={{ color: 'var(--fg-muted)', textDecoration: 'underline' }}
            >
              none — set
            </Link>
          )}
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
        <NavLink to={`/project/${projectId}/recordings`} style={({ isActive }) => linkStyle(isActive)}>
          Recordings
        </NavLink>
        <NavLink to={`/project/${projectId}/review`} style={({ isActive }) => linkStyle(isActive)}>
          Quality Review
        </NavLink>

        {/* Scene list moved into the Storyboard page (master-detail layout).
            Scenes are clickable rows there with status badges and inline
            editing — see pages/StoryboardView.tsx. */}

        {/* Library section */}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 4 }}>
          <p style={sectionLabel}>Library</p>
          <NavLink to="/brands" style={({ isActive }) => linkStyle(isActive)}>
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
