import { Link, NavLink, useLocation, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Captions,
  CheckCircle2,
  Clapperboard,
  FileText,
  Film,
  FolderKanban,
  Mic2,
  PanelLeftClose,
  PanelLeftOpen,
  Video,
} from 'lucide-react';

export function ProjectSidebar({
  projectName,
  collapsed,
  onCollapsedChange,
}: {
  projectName: string;
  collapsed: boolean;
  onCollapsedChange: (value: boolean) => void;
}) {
  const { projectId } = useParams();
  const { pathname } = useLocation();
  const base = `/project/${projectId}`;
  const links = [
    { label: 'Overview', to: base, Icon: FolderKanban, end: true },
    { label: 'Scenes', to: `${base}/storyboard`, Icon: Clapperboard },
    { label: 'Script', to: `${base}/script`, Icon: FileText },
    { label: 'Narration', to: `${base}/narration`, Icon: Mic2 },
    { label: 'Render', to: `${base}/render`, Icon: Film },
    { label: 'Review', to: `${base}/review`, Icon: CheckCircle2 },
  ];
  const tools = [
    { label: 'Recordings', route: 'recordings', Icon: Video },
    { label: 'On-screen text', route: 'lower-thirds', Icon: Captions },
  ];
  return (
    <nav
      className={`project-sidebar workspace-navigation${collapsed ? ' workspace-navigation--compact' : ''}`}
      aria-label={`${projectName} navigation`}
    >
      <header>
        <span title={projectName}>{projectName}</span>
        <button
          type="button"
          aria-label={collapsed ? 'Expand project navigation' : 'Collapse project navigation'}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </header>
      {links.map(({ label, to, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          title={label}
          className={({ isActive }) => `workspace-navigation__link${isActive ? ' is-active' : ''}`}
        >
          <Icon size={19} />
          <span>{label}</span>
        </NavLink>
      ))}
      <details
        className="workspace-navigation__tools"
        open={tools.some((tool) => pathname === `${base}/${tool.route}`) || undefined}
      >
        <summary title="More tools">More tools</summary>
        {tools.map(({ label, route, Icon }) => (
          <NavLink key={route} to={`${base}/${route}`} title={label}>
            <Icon size={15} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </details>
      <footer>
        <Link to="/" title="All projects"><ArrowLeft size={15} aria-hidden="true" /><span>All projects</span></Link>
      </footer>
    </nav>
  );
}
