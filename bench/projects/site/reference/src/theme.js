// Pure theme logic. The stored value is the user's override: 'light', 'dark' or nothing.

export const THEME_KEY = 'northwind.theme';

export function resolveTheme(stored, systemDark) {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemDark ? 'dark' : 'light';
}

/** The override to store when the toggle is pressed while `current` is shown. */
export function toggled(current) {
  return current === 'dark' ? 'light' : 'dark';
}
