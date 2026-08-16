/**
 * Legacy `.loctx.yaml` project-config helpers (#542 split from
 * config.ts). The loader no longer reads these files; `start.ts` scans
 * for them to print a one-time deprecation warning.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, parse as parsePath, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const LEGACY_PROJECT_CONFIG_FILENAME = ".loctx.yaml";

/**
 * Walk up from `cwd` looking for a legacy `.loctx.yaml`. Returns the
 * first match (closest to cwd) or null. Used by the daemon to surface a
 * deprecation warning — the loader no longer reads these files.
 */
export function findLegacyProjectConfig(cwd: string): string | null {
  let cur = resolve(cwd);
  // Bound: walk ≤ 64 levels in case of weird symlinks. fs root halts naturally.
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(cur, LEGACY_PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = parsePath(cur).dir;
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * Parse a legacy `.loctx.yaml` and return a summary of the leaf
 * settings the new loader is ignoring. Used by `warnOnLegacyProjectConfig`
 * to produce an actionable warning (showing what's being dropped vs the
 * old vague "move its contents" prompt). Empty array means "file exists
 * but contains nothing the user would care about" — typical when an
 * old file got truncated to `{}` or has only comments.
 */
export function summarizeLegacyProjectConfig(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { merge: false, maxAliasCount: 100 });
  } catch {
    return [`<unparseable YAML in ${path}>`];
  }
  if (parsed === null || parsed === undefined || typeof parsed !== "object") return [];
  const out: string[] = [];
  walkLeaves(parsed as Record<string, unknown>, "", out);
  return out;
}

function walkLeaves(obj: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      walkLeaves(v as Record<string, unknown>, key, out);
    } else {
      out.push(`${key}=${JSON.stringify(v)}`);
    }
  }
}
