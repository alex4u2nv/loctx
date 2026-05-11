/** Display helpers shared across pages. */

/**
 * Render an ISO timestamp as relative time (`5m ago`, `2h ago`, `3d ago`).
 * Falls back to a localised date string for anything past 7 days.
 */
export function relativeTime(iso: string | null): string {
  if (iso === null) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Compress an absolute path for display.
 *   - Replace `homeDir` prefix with `~`.
 *   - Strip `commonRoot` prefix (keeping a leading `/` so it reads as a
 *     subpath of the header). Never strip when the result would be empty.
 */
export function compressPath(path: string, homeDir: string, commonRoot: string): string {
  let p = path;
  if (commonRoot !== "" && p.startsWith(`${commonRoot}/`)) {
    p = p.slice(commonRoot.length + 1);
  } else if (commonRoot !== "" && p === commonRoot) {
    p = ".";
  } else if (homeDir !== "" && p.startsWith(`${homeDir}/`)) {
    p = `~/${p.slice(homeDir.length + 1)}`;
  } else if (homeDir !== "" && p === homeDir) {
    p = "~";
  }
  return p;
}

export function applyHomeAbbrev(path: string, homeDir: string): string {
  if (homeDir === "") return path;
  if (path === homeDir) return "~";
  if (path.startsWith(`${homeDir}/`)) return `~/${path.slice(homeDir.length + 1)}`;
  return path;
}
