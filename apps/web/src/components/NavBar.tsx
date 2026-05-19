import { Link, useLocation } from 'react-router-dom';
import { SaveIndicator } from './ui/SaveIndicator.js';
import { ThemeToggle } from './ui/ThemeToggle.js';

export function NavBar() {
  const location = useLocation();
  const isHome = location.pathname === '/';

  return (
    <nav className="navbar">
      <div className="navbar__inner">
        <Link to="/" className="navbar__brand">
          <svg className="navbar__logo" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          <span className="navbar__title">VPA</span>
        </Link>

        {!isHome && (
          <Link to="/" className="navbar__back" title="Dashboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </Link>
        )}

        <div className="navbar__spacer" />

        <ThemeToggle />

        <SaveIndicator />

        <span
          aria-hidden
          title="Press ⌘K to open command palette"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            fontSize: 11,
            color: 'var(--fg-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cursor: 'help',
          }}
        >
          ⌘K
        </span>

        <Link
          to="/brands"
          className={`navbar__link${location.pathname.startsWith('/brands') ? ' navbar__link--active' : ''}`}
          title="Brands"
        >
          Brands
        </Link>
        <Link
          to="/voices"
          className={`navbar__link${location.pathname.startsWith('/voices') ? ' navbar__link--active' : ''}`}
          title="Voice clones — reference recordings used by TTS providers"
        >
          Voice Clones
        </Link>
        <Link
          to="/setup"
          className={`navbar__link${location.pathname.startsWith('/setup') ? ' navbar__link--active' : ''}`}
          title="Setup health check"
        >
          Setup
        </Link>

        <Link
          to="/settings"
          className={`navbar__icon${location.pathname === '/settings' ? ' navbar__icon--active' : ''}`}
          title="Settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </div>
    </nav>
  );
}
