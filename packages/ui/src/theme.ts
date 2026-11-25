export type SaathTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "saath-theme";

export function resolveInitialTheme(): SaathTheme {
  if (typeof window === "undefined") {
    return "light";
  }
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") {
    return attr;
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // Ignore storage access failures in private contexts
  }
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function applyTheme(theme: SaathTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}

export const ANTI_FOUC_THEME_SCRIPT = `
(function() {
  try {
    var t = localStorage.getItem('saath-theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.dataset.theme = t;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.dataset.theme = 'dark';
    }
  } catch (e) {}
})();
`;
