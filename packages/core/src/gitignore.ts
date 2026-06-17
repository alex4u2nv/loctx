/**
 * Gitignore-aware path matching.
 *
 * What we honor (in matching order; later patterns can negate earlier
 * ones, gitignore-style):
 *
 *   1. Git's global excludes (`git config --global core.excludesFile`,
 *      falling back to `~/.config/git/ignore`).
 *   2. Per-project `.git/info/exclude`.
 *   3. **Built-in negation for AI-tooling state dirs** (#375). Most
 *      developers list `.claude/`, `.cursor/`, `.aider/` in their
 *      `~/.gitignore_global` to keep AI tooling state out of git
 *      commits. That's a VCS posture — but for loctx those dirs hold
 *      project intent (rules, prompts, slash commands) that should be
 *      searchable. We re-include them here so the common case "just
 *      works". A project that genuinely doesn't want them indexed by
 *      loctx can still ignore them via `.loctxignore` below.
 *   4. Per-project root rule files (`.gitignore`, `.loctxignore`,
 *      `.cursorignore`, `.aiderignore`, `.ignore`). These come AFTER
 *      the built-in re-include, so `.loctxignore: .claude/` wins over
 *      the auto-include.
 *   5. **Nested** versions of the rule files in any subdirectory.
 *      Patterns in a nested file scope to that subdirectory's subtree,
 *      exactly as `git` itself applies them.
 *
 * Why .cursorignore / .aiderignore / .ignore: same syntax as gitignore;
 * `.cursorignore` and `.aiderignore` carry an explicit "don't feed this
 * to an AI" signal that aligns with loctx's purpose; `.ignore` is the
 * universal cross-tool form recognised by ripgrep, fd, ag, etc.
 *
 * Tool-specific ignores (`.dockerignore`, `.npmignore`, `.eslintignore`,
 * `.helmignore`) are deliberately NOT honored — they encode publish /
 * lint / build intent, not "don't index for code search", and pulling
 * them in would silently drop config files users want indexed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Ignore } from "ignore";

// `ignore`@6 ships as CJS — its default export is a callable function whose
// types collide with a declared namespace, so an ESM `import ignore from
// "ignore"` resolves to the namespace, not the function. Use createRequire
// to grab the runtime CJS export directly.
const require = createRequire(import.meta.url);
const ignoreFactory = require("ignore") as (options?: {
  ignoreCase?: boolean;
  allowRelativePaths?: boolean;
}) => Ignore;

const DEFAULT_FALLBACK = join(homedir(), ".config", "git", "ignore");

/** Filenames we treat as gitignore-syntax sources. */
export const RULE_FILENAMES = [
  ".gitignore",
  ".loctxignore",
  ".cursorignore",
  ".aiderignore",
  ".ignore",
] as const;

/** Per-project ignore file specific to loctx. */
export const LOCTXIGNORE_FILENAME = ".loctxignore";

/**
 * Built-in re-include patterns for AI-tooling state directories — see
 * file header (#375). These are injected into the root layer between
 * the global/git-info excludes and the project-root rule files. A user
 * who wants loctx to skip these dirs can override via `.loctxignore`,
 * which evaluates after this list.
 *
 * Each dir needs both the dir-form (`!path/`) and the contents-form
 * (`!path/**`) because gitignore's "can't re-include children of an
 * ignored parent" rule means we have to un-ignore the directory first
 * before its contents become visible to subsequent matchers.
 */
export const AI_TOOLING_AUTO_INCLUDE: readonly string[] = Object.freeze([
  "!.claude/",
  "!.claude/**",
  "!.cursor/",
  "!.cursor/**",
  "!.aider/",
  "!.aider/**",
]);

/**
 * What ProjectFilter consumes. Both the single-Ignore (legacy) and the
 * layered nested-aware impl satisfy this contract.
 */
export interface GitignoreSpec {
  ignores(relPath: string): boolean;
}

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
 * Build a layered ignore spec rooted at `root`. The root layer carries
 * global excludes + .git/info/exclude + every root-level rule file. Each
 * subdirectory that contains a rule file gets its own layer scoped to
 * its subtree. Lookup walks every ancestor layer for each query path.
 */
export function combinedGitignore(root: string): GitignoreSpec | null {
  const rootLines: string[] = [
    ...readLines(gitGlobalExcludesFile()),
    ...readLines(DEFAULT_FALLBACK),
    ...readLines(join(root, ".git", "info", "exclude")),
    // Built-in re-include — see AI_TOOLING_AUTO_INCLUDE docstring.
    // Order matters: this sits after the global/info layers (so it
    // negates them) but before the per-project rule files (so a
    // .loctxignore entry can re-ignore if the user really wants it).
    ...AI_TOOLING_AUTO_INCLUDE,
  ];
  for (const name of RULE_FILENAMES) {
    rootLines.push(...readLines(join(root, name)));
  }
  const rootLayer = rootLines.length > 0 ? ignoreFactory().add(rootLines) : null;

  // Walk for nested rule files. Skip ignored subtrees so we don't waste
  // cycles in node_modules etc.; the root layer is enough to make that
  // decision because nested ignores don't apply outside their dir.
  const nested = findNestedRuleFiles(root, rootLayer);
  if (rootLayer === null && nested.size === 0) return null;

  return new LayeredGitignore(rootLayer, nested);
}

// ---- layered impl ------------------------------------------------------

class LayeredGitignore implements GitignoreSpec {
  constructor(
    private readonly rootLayer: Ignore | null,
    /** Map from `<dir-relative-to-root>` to the Ignore for that dir's rule files. */
    private readonly subLayers: ReadonlyMap<string, Ignore>,
  ) {}

  ignores(relPath: string): boolean {
    if (this.rootLayer?.ignores(relPath)) return true;
    if (this.subLayers.size === 0) return false;

    // Walk every ancestor directory of relPath. If a layer exists at that
    // ancestor, ask it whether the path-relative-to-ancestor is ignored.
    const segments = relPath.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const dirRel = segments.slice(0, depth).join("/");
      const layer = this.subLayers.get(dirRel);
      if (layer === undefined) continue;
      const subRel = segments.slice(depth).join("/");
      if (subRel === "") continue;
      if (layer.ignores(subRel)) return true;
    }
    return false;
  }
}

/**
 * Walk `root` discovering nested rule files. Returns a map of
 * `<dir-relative-to-root>` (no leading slash, forward-slash separators)
 * to the merged Ignore instance for that directory.
 *
 * Performance: skips subtrees the root layer already ignores; bails on
 * permission errors. Does not follow symlinks (stat-only).
 */
function findNestedRuleFiles(root: string, rootLayer: Ignore | null): Map<string, Ignore> {
  const out = new Map<string, Ignore>();
  // Hard-coded skip list for noisy directories so we stay snappy on a
  // monorepo with thousands of node_modules dirs without depending on
  // the project's own .gitignore being correct.
  const ALWAYS_SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    "target",
    "vendor",
  ]);

  const walk = (absDir: string, relDir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      // `encoding: "utf8"` keeps Dirent.name typed as string instead of
      // Buffer; without it newer @types/node infer NonSharedBuffer here.
      entries = readdirSync(absDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    // Collect rule files in this directory (skip the root — already merged).
    if (relDir !== "") {
      const lines: string[] = [];
      for (const name of RULE_FILENAMES) {
        if (entries.some((e) => e.isFile() && e.name === name)) {
          lines.push(...readLines(join(absDir, name)));
        }
      }
      if (lines.length > 0) {
        out.set(relDir.split(sep).join("/"), ignoreFactory().add(lines));
      }
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (ALWAYS_SKIP.has(e.name)) continue;
      const childRel = relDir === "" ? e.name : `${relDir}${sep}${e.name}`;
      const childRelForward = childRel.split(sep).join("/");
      // Cheap: ask the root layer; if the dir itself is gitignored, no
      // point reading its children.
      if (rootLayer?.ignores(`${childRelForward}/`)) continue;
      try {
        const st = statSync(join(absDir, e.name));
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      walk(join(absDir, e.name), childRel);
    }
  };

  walk(root, "");
  return out;
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
  return lines.length > 0 ? ignoreFactory().add(lines) : null;
}
