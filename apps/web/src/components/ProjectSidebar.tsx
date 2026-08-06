import { Link, NavLink, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AudioLines,
  CheckCircle2,
  Clapperboard,
  FileText,
  Film,
  FolderKanban,
  Home,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  Tags,
  Video,
  type LucideIcon,
} from 'lucide-react';
import type { WorkflowStepKey } from '@vpa/shared';
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

const WORKFLOW_DESTINATIONS: Array<{
  key: WorkflowStepKey;
  label: string;
  segment: string;
  icon: LucideIcon;
}> = [
  { key: 'storyboard', label: 'Storyboard', segment: 'storyboard', icon: Clapperboard },
  { key: 'recordings', label: 'Recordings', segment: 'recordings', icon: Video },
  { key: 'script', label: 'Script', segment: 'script', icon: FileText },
  { key: 'narration', label: 'Narration', segment: 'narration', icon: AudioLines },
  { key: 'lower-thirds', label: 'Lower Thirds', segment: 'lower-thirds', icon: Tags },
  { key: 'render', label: 'Render', segment: 'render', icon: Film },
  { key: 'review', label: 'Review', segment: 'review', icon: CheckCircle2 },
];

interface Props {
  projectName: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function ProjectSidebar({ projectName, collapsed, onCollapsedChange }: Props) {
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

  const { steps } = usePipelineSteps(projectId);
  const stepByKey = new Map(steps.map((step) => [step.key, step]));
  const navigationSteps = WORKFLOW_DESTINATIONS.map<PipelineStep>((destination) => (
    stepByKey.get(destination.key) ?? {
      key: destination.key,
      label: destination.label,
      to: `/project/${projectId}/${destination.segment}`,
      status: 'todo',
      state: 'blocked',
      detail: `${destination.label} workspace`,
    }
  ));

  const appliedBrandId = project?.brand?.id ?? null;
  const appliedBrand = brandRegistry?.brands.find((brand) => brand.id === appliedBrandId) ?? null;

  if (collapsed) {
    return (
      <nav
        className="project-sidebar project-sidebar--compact"
        aria-label={`${projectName} navigation`}
      >
        <div className="project-sidebar__compact-header">
          <button
            type="button"
            className="project-sidebar__collapse-control"
            aria-label="Expand project navigation"
            title="Expand project navigation"
            onClick={() => onCollapsedChange(false)}
          >
            <PanelLeftOpen size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="project-sidebar__compact-nav">
          <CompactLink
            to={`/project/${projectId}`}
            label="Overview"
            icon={FolderKanban}
            end
          />
          <div className="project-sidebar__compact-divider" aria-hidden="true" />
          {navigationSteps.map((step) => (
            <CompactStep key={step.key} step={step} />
          ))}
        </div>

        <div className="project-sidebar__compact-library">
          <CompactLink to="/brands" label="Brands" icon={Library} />
          <CompactLink to="/" label="All projects" icon={Home} />
        </div>
      </nav>
    );
  }

  return (
    <nav
      className="project-sidebar"
      aria-label={`${projectName} navigation`}
      style={{
        width: 240,
        minWidth: 240,
        background: 'linear-gradient(180deg, var(--panel-grad-top), var(--bg-elev))',
        borderRight: '1px solid var(--border)',
        boxShadow:
          'inset -1px 0 0 var(--border-soft, var(--border)), inset 0 1px 0 rgba(255,255,255,0.5)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div className="project-sidebar__header">
        <div className="project-sidebar__title-row">
          <div className="project-sidebar__project-name" title={projectName}>{projectName}</div>
          <button
            type="button"
            className="project-sidebar__collapse-control"
            aria-label="Collapse project navigation"
            title="Collapse project navigation"
            onClick={() => onCollapsedChange(true)}
          >
            <PanelLeftClose size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="project-sidebar__brand">
          <span>Brand:</span>
          {appliedBrand ? (
            <Link
              to={`/brands/${appliedBrand.id}`}
              title={`${appliedBrand.name} (v${project?.brand?.applied_version ?? appliedBrand.version})`}
            >
              {appliedBrand.name}
            </Link>
          ) : (
            <Link to={`/project/${projectId}#brand`}>none — set</Link>
          )}
        </div>
      </div>

      <div className="project-sidebar__nav">
        <NavLink
          className="project-sidebar__link"
          to={`/project/${projectId}`}
          aria-label="Overview"
          end
          style={({ isActive }) => flatLinkStyle(isActive)}
        >
          Overview
        </NavLink>

        <p className="project-sidebar__section-label" style={sectionLabel}>Workflow</p>
        {navigationSteps.map((step, index) => (
          <SidebarStep key={step.key} step={step} number={index + 1} />
        ))}

        <div className="project-sidebar__library">
          <p className="project-sidebar__section-label" style={sectionLabel}>Library</p>
          <NavLink
            className="project-sidebar__link"
            to="/brands"
            aria-label="Brands"
            style={({ isActive }) => flatLinkStyle(isActive)}
          >
            Brands
          </NavLink>
        </div>
      </div>

      <div className="project-sidebar__back">
        <NavLink className="project-sidebar__back-link" to="/" aria-label="All projects">
          ← All projects
        </NavLink>
      </div>
    </nav>
  );
}

function SidebarStep({ step, number }: { step: PipelineStep; number: number }) {
  return (
    <NavLink
      className="project-sidebar__step"
      to={step.to}
      aria-label={step.label}
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
        aria-hidden="true"
        className="project-sidebar__step-badge"
        style={{
          background: stepBadgeBg(step.status),
          color: stepBadgeFg(step.status),
          border: stepBadgeBorder(step.status),
        }}
      >
        {step.status === 'done' ? '✓' : step.status === 'stale' ? '!' : number}
      </span>
      <span className={`project-sidebar__step-label${step.status === 'todo' ? ' project-sidebar__step-label--todo' : ''}`}>
        {step.label}
      </span>
      {step.status === 'next' && <span className="project-sidebar__next">Next</span>}
    </NavLink>
  );
}

function CompactStep({ step }: { step: PipelineStep }) {
  const destination = WORKFLOW_DESTINATIONS.find((item) => item.key === step.key)!;
  return (
    <CompactLink
      to={step.to}
      label={step.label}
      icon={destination.icon}
      status={step.status}
      end={step.key === 'review'}
    />
  );
}

function CompactLink({
  to,
  label,
  icon: Icon,
  status,
  end,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  status?: PipelineStepStatus;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      title={label}
      end={end}
      className={({ isActive }) => (
        `project-sidebar__compact-link${isActive ? ' project-sidebar__compact-link--active' : ''}`
      )}
    >
      <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
      {status && (
        <span
          className={`project-sidebar__compact-status project-sidebar__compact-status--${status}`}
          aria-hidden="true"
        />
      )}
    </NavLink>
  );
}

function stepBadgeBg(status: PipelineStepStatus): string {
  if (status === 'done') return STATUS_COLOR.success;
  if (status === 'next') return 'var(--accent-2)';
  if (status === 'stale') return 'var(--warn, #d4a017)';
  return 'transparent';
}

function stepBadgeFg(status: PipelineStepStatus): string {
  if (status === 'done' || status === 'next' || status === 'stale') return '#fff';
  return 'var(--fg-muted)';
}

function stepBadgeBorder(status: PipelineStepStatus): string {
  return status === 'todo' ? '1px solid var(--border)' : 'none';
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
