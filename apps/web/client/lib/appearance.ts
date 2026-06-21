/**
 * Appearance (theme + layout) selection. Themes swap CSS custom-property
 * token sets via `data-theme` on <html>; layouts restructure the shell via
 * `data-layout`. Both persist to localStorage and are applied before first
 * paint (see initAppearance in main.tsx) so there's no flash.
 *
 * Adding a theme = one entry here + one `[data-theme="id"]` block + one
 * `.swatch-id` in styles.css. Nothing else references the ids.
 */

export interface AppearanceOption {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}

export const THEMES: ReadonlyArray<AppearanceOption> = [
  { id: "aurora", label: "Aurora", hint: "Apple light · system blue, airy" },
  { id: "paper", label: "Paper", hint: "Warm editorial · serif, terracotta" },
  { id: "graphite", label: "Graphite", hint: "Apple dark" },
  { id: "midnight", label: "Midnight", hint: "Deep indigo · violet accent" },
  { id: "terminal", label: "Terminal", hint: "Monospace · green on black" },
];

export const LAYOUTS: ReadonlyArray<AppearanceOption> = [
  { id: "top", label: "Top bar", hint: "Horizontal nav (default)" },
  { id: "sidebar", label: "Sidebar", hint: "Left vertical rail" },
];

const THEME_KEY = "loctx.theme";
const LAYOUT_KEY = "loctx.layout";
const DEFAULT_THEME = "aurora";
const DEFAULT_LAYOUT = "top";

function read(key: string, fallback: string, valid: ReadonlyArray<AppearanceOption>): string {
  try {
    const v = localStorage.getItem(key);
    return v !== null && valid.some((o) => o.id === v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function getTheme(): string {
  return read(THEME_KEY, DEFAULT_THEME, THEMES);
}

export function getLayout(): string {
  return read(LAYOUT_KEY, DEFAULT_LAYOUT, LAYOUTS);
}

export function applyTheme(id: string): void {
  document.documentElement.dataset["theme"] = id;
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // private mode / storage disabled — the data attribute still applies for the session
  }
}

export function applyLayout(id: string): void {
  document.documentElement.dataset["layout"] = id;
  try {
    localStorage.setItem(LAYOUT_KEY, id);
  } catch {
    // see applyTheme
  }
}

/** Apply persisted appearance to <html> before React renders. */
export function initAppearance(): void {
  document.documentElement.dataset["theme"] = getTheme();
  document.documentElement.dataset["layout"] = getLayout();
}
