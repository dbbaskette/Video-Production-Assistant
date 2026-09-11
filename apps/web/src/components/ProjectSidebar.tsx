import { Link, NavLink, useLocation, useParams } from 'react-router-dom';
import { FolderKanban, Clapperboard, Film, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

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
    { label: 'Project', to: base, Icon: FolderKanban, end: true },
    { label: 'Scenes', to: `${base}/storyboard`, Icon: Clapperboard },
    { label: 'Review & export', to: `${base}/render`, Icon: Film },
  ];
  const tools = [
    { label: 'Source recordings', route: 'recordings' },
    { label: 'Full script', route: 'script' },
    { label: 'Batch narration', route: 'narration' },
    { label: 'Text overview', route: 'lower-thirds' },
    { label: 'Automated quality checks', route: 'review' },
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
        <summary>Production tools</summary>
        {tools.map((tool) => (
          <NavLink key={tool.route} to={`${base}/${tool.route}`}>
            {tool.label}
          </NavLink>
        ))}
      </details>
      <footer>
        <Link to="/brands">Brand library</Link>
        <Link to="/voices">Voice library</Link>
        <Link to="/">All projects</Link>
      </footer>
    </nav>
  );
}
