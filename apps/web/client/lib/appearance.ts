/**
 * Theme selection. Themes swap CSS custom-property token sets via
 * `data-theme` on <html>, persist to localStorage, and are applied before
 * first paint (see initAppearance in main.tsx) so there's no flash.
 *
 * Adding a theme = one entry here + one `[data-theme="id"]` block + one
 * `.swatch-id` in styles.css. Nothing else references the ids.
 *
 * (The layout is fixed: a left sidebar on desktop with a responsive top
 * strip on narrow screens — handled purely in CSS, no toggle.)
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
  { id: "midnight", label: "Midnight", hint: "Deep slate · violet accent" },
  { id: "terminal", label: "Terminal", hint: "Monospace · green on black" },
];

const THEME_KEY = "loctx.theme";
const DEFAULT_THEME = "aurora";

export function getTheme(): string {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v !== null && THEMES.some((o) => o.id === v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: string): void {
  document.documentElement.dataset["theme"] = id;
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // private mode / storage disabled — the data attribute still applies for the session
  }
}

/** Apply the persisted theme to <html> before React renders. */
export function initAppearance(): void {
  document.documentElement.dataset["theme"] = getTheme();
}
