import { useTheme } from '../../lib/theme.js';

/**
 * Segmented Light/Dark toggle for the NavBar. Renders the active mode
 * with the .is-active state of the .segmented base style.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();

  return (
    <div className="segmented" role="group" aria-label="Theme">
      <button
        type="button"
        className={theme === 'light' ? 'is-active' : ''}
        aria-pressed={theme === 'light'}
        onClick={() => setTheme('light')}
        title="Light theme"
      >
        Light
      </button>
      <button
        type="button"
        className={theme === 'dark' ? 'is-active' : ''}
        aria-pressed={theme === 'dark'}
        onClick={() => setTheme('dark')}
        title="Dark theme"
      >
        Dark
      </button>
    </div>
  );
}
