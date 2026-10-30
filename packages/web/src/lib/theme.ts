import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'prego-theme';
const listeners = new Set<(theme: Theme) => void>();

/** index.html sets the starting theme before the first paint (saved choice, else the system setting). */
function current(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private windows can refuse storage; the theme still applies for this visit.
  }
  for (const listener of listeners) listener(theme);
}

export function useTheme(): Theme {
  const [theme, set] = useState(current);
  useEffect(() => {
    listeners.add(set);
    return () => void listeners.delete(set);
  }, []);
  return theme;
}
