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

/**
 * Render a byte count as a human-readable size (`1.2 GB`, `340 MB`,
 * `12 KB`). Binary units (1024-based) labelled with the conventional
 * MB/GB suffixes. Sub-KB values render as bytes; one decimal from MB up.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  // Whole numbers for B/KB; one decimal for MB and up so the dashboard
  // reads "1.2 GB" rather than "1 GB".
  const decimals = exp >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[exp]}`;
}

/**
 * Compact count for big, approximate figures: 812 → "812", 5_400 →
 * "5.4k", 1_240_000 → "1.2M". Used for the estimated tokens-saved tile,
 * where exact digits would imply false precision.
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function applyHomeAbbrev(path: string, homeDir: string): string {
  if (homeDir === "") return path;
  if (path === homeDir) return "~";
  if (path.startsWith(`${homeDir}/`)) return `~/${path.slice(homeDir.length + 1)}`;
  return path;
}
