/**
 * Light/dark mode. A single `.dark` class on <html> flips the token set;
 * the choice persists to localStorage and is applied before first paint
 * (see initAppearance in main.tsx) so there's no flash.
 *
 * (The previous multi-theme `data-theme` system was replaced by this
 * two-mode convention.)
 */

export type ColorMode = "light" | "dark";

const MODE_KEY = "loctx.mode";

export function getMode(): ColorMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // storage disabled — fall through to system preference
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export function applyMode(mode: ColorMode): void {
  document.documentElement.classList.toggle("dark", mode === "dark");
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // private mode / storage disabled — the class still applies for the session
  }
}

export function toggleMode(): ColorMode {
  const next: ColorMode = getMode() === "dark" ? "light" : "dark";
  applyMode(next);
  return next;
}

/** Apply the persisted mode to <html> before React renders. */
export function initAppearance(): void {
  document.documentElement.classList.toggle("dark", getMode() === "dark");
}
