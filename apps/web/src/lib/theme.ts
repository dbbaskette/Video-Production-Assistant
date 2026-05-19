/**
 * Theme store — owns the data-theme attribute on <html> and the
 * localStorage key. The bootstrap script in `index.html` reads the same
 * key before paint to avoid a flash on dark-mode users.
 *
 * Light is the default. Dark is opt-in. If the user has not chosen
 * explicitly, the bootstrap follows the OS preference, but the store
 * still surfaces the resolved value so the toggle can show the active
 * choice.
 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'vpaTheme';

function readTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'dark' ? 'dark' : 'light';
}

export function setTheme(next: Theme): void {
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* localStorage may be disabled in private browsing — non-fatal */
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(() => readTheme());

  useEffect(() => {
    // Sync if something external (devtools, another tab) changes the attr.
    const observer = new MutationObserver(() => set(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return [
    theme,
    (next: Theme) => {
      setTheme(next);
      set(next);
    },
  ];
}
