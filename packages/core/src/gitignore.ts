/**
 * Gitignore-aware path matching.
 *
 * Layers (any may be absent), applied in this order so per-project rules
 * can override system defaults but the loctx baseline still wins:
 *
 *   1. Git's global excludes (`git config --global core.excludesfile`,
 *      falling back to `~/.config/git/ignore`).
 *   2. Per-project `.gitignore` at the project root.
 *   3. Per-project `.git/info/exclude`.
 *   4. Per-project `.loctxignore` — same syntax as `.gitignore`, but
 *      addressed at loctx's indexer specifically. Useful when a path
 *      should be tracked by git but not embedded (e.g. `vendor/`,
 *      generated fixtures, large binary corpora).
 *
 * These rules are applied as additional ignores on top of the loctx baseline.
 * They can only ADD ignores; they cannot un-ignore a file the loctx baseline
 * marks as a secret, oversized, or binary.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ignore } from "ignore";

// `ignore`@6 ships as CJS — its default export is a callable function whose
// types collide with a declared namespace, so an ESM `import ignore from
// "ignore"` resolves to the namespace, not the function. Use createRequire
// to grab the runtime CJS export directly.
const require = createRequire(import.meta.url);
const ignore = require("ignore") as (options?: {
  ignoreCase?: boolean;
  allowRelativePaths?: boolean;
}) => Ignore;

const DEFAULT_FALLBACK = join(homedir(), ".config", "git", "ignore");

export type GitignoreSpec = Ignore;

export function loadGlobalGitignore(): GitignoreSpec | null {
  const paths: string[] = [];
  const configured = gitGlobalExcludesFile();
  if (configured !== null) paths.push(configured);
  if (existsSync(DEFAULT_FALLBACK) && !paths.includes(DEFAULT_FALLBACK)) {
    paths.push(DEFAULT_FALLBACK);
  }
  return specFromFiles(paths);
}

export function loadProjectGitignore(root: string): GitignoreSpec | null {
  return specFromFiles([
    join(root, ".gitignore"),
    join(root, ".git", "info", "exclude"),
    join(root, LOCTXIGNORE_FILENAME),
  ]);
}

/**
 * Per-project ignore file specific to loctx. Same syntax as .gitignore but
 * lets a project tell loctx to skip paths it still wants tracked in git.
 */
export const LOCTXIGNORE_FILENAME = ".loctxignore";

export function combinedGitignore(root: string): GitignoreSpec | null {
  const lines: string[] = [
    ...readLines(gitGlobalExcludesFile()),
    ...readLines(DEFAULT_FALLBACK),
    ...readLines(join(root, ".gitignore")),
    ...readLines(join(root, ".git", "info", "exclude")),
    ...readLines(join(root, LOCTXIGNORE_FILENAME)),
  ];
  return lines.length > 0 ? ignore().add(lines) : null;
}

// ---- helpers -----------------------------------------------------------

function gitGlobalExcludesFile(): string | null {
  try {
    const raw = execFileSync("git", ["config", "--global", "--get", "core.excludesfile"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (!raw) return null;
    const expanded = expandHome(raw);
    return existsSync(expanded) ? expanded : null;
  } catch {
    return null;
  }
}

function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return homedir() + path.slice(1);
  }
  return path;
}

function readLines(path: string | null): string[] {
  if (path === null || !existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function specFromFiles(paths: Iterable<string>): GitignoreSpec | null {
  const lines: string[] = [];
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        lines.push(...readFileSync(path, "utf-8").split(/\r?\n/));
      } catch {
        // ignore unreadable files
      }
    }
  }
  return lines.length > 0 ? ignore().add(lines) : null;
}
