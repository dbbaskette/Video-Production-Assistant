import { Link, NavLink, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, brandsApi } from '../lib/api.js';
import { usePipelineSteps, type PipelineStep, type PipelineStepStatus } from '../lib/pipeline.js';
import { STATUS_COLOR } from '../lib/palette.js';

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

  // Pipeline steps from the same source as the Project Overview's Pipeline
  // — the sidebar renders a compact version (number + status dot + label)
  // so the user can see workflow ordering and progress regardless of
  // which page they're on. Replaces the previous flat link list which
  // gave no hint about which step was next or which were done.
  const { steps } = usePipelineSteps(projectId);

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
        {/* Overview lives outside the pipeline (it's the meta-view) */}
        <NavLink
          to={`/project/${projectId}`}
          end
          style={({ isActive }) => flatLinkStyle(isActive)}
        >
          Overview
        </NavLink>

        {/* Pipeline: numbered workflow steps with status dots */}
        <p style={sectionLabel}>Workflow</p>
        {steps.map((step, i) => (
          <SidebarStep key={step.key} step={step} number={i + 1} />
        ))}

        {/* Library section */}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 4 }}>
          <p style={sectionLabel}>Library</p>
          <NavLink to="/brands" style={({ isActive }) => flatLinkStyle(isActive)}>
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

// ── Sidebar step row ─────────────────────────────────────────────────
//
// Compact: number-or-check badge + label + optional "NEXT" pill.
// Active route highlights via the same accent treatment NavLink uses
// elsewhere; the status badge reflects pipeline progress regardless of
// which route is active.

function SidebarStep({ step, number }: { step: PipelineStep; number: number }) {
  return (
    <NavLink
      to={step.to}
      end={step.key === 'review'}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        borderRadius: 6,
        textDecoration: 'none',
        color: isActive ? 'var(--accent)' : 'var(--fg)',
        background: isActive ? 'var(--accent-bg)' : 'transparent',
        fontSize: 13,
        fontWeight: isActive ? 600 : 400,
        marginBottom: 2,
      })}
      title={step.detail}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          borderRadius: '50%',
          fontSize: 10,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: stepBadgeBg(step.status),
          color: stepBadgeFg(step.status),
          border: stepBadgeBorder(step.status),
        }}
      >
        {step.status === 'done' ? '✓' : number}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          opacity: step.status === 'todo' ? 0.55 : 1,
        }}
      >
        {step.label}
      </span>
      {step.status === 'next' && (
        <span
          aria-label="next step"
          style={{
            fontSize: 9,
            color: 'var(--accent)',
            textTransform: 'uppercase',
            letterSpacing: 1,
            fontWeight: 700,
          }}
        >
          Next
        </span>
      )}
    </NavLink>
  );
}

function stepBadgeBg(status: PipelineStepStatus): string {
  if (status === 'done') return STATUS_COLOR.success;
  if (status === 'next') return 'var(--accent)';
  return 'transparent';
}
function stepBadgeFg(status: PipelineStepStatus): string {
  if (status === 'done' || status === 'next') return '#fff';
  return 'var(--fg-muted)';
}
function stepBadgeBorder(status: PipelineStepStatus): string {
  if (status === 'todo') return '1px solid var(--border)';
  return 'none';
}

function flatLinkStyle(isActive: boolean): React.CSSProperties {
  return {
    display: 'block',
    padding: '8px 16px',
    borderRadius: 6,
    color: isActive ? 'var(--accent)' : 'var(--fg)',
    background: isActive ? 'var(--accent-bg)' : 'transparent',
    textDecoration: 'none',
    fontSize: 14,
    fontWeight: isActive ? 600 : 400,
    marginBottom: 2,
  };
}
