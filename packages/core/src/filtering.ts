/**
 * Per-project file eligibility decisions.
 *
 * Baseline rules live in `filtering-defaults.ts` (inlined TS literal so
 * webpack doesn't rewrite `new URL(..., import.meta.url)` and break Node's
 * `fileURLToPath`). User overrides come from `~/.loctx/config_overrides/*.
 * {yaml,yml}` in alphabetical filename order. Gitignore (global + per-
 * project) is layered as additional ignore rules at filter-construction
 * time.
 *
 * Decisions carry a stable `FilterReason` so `loctx doctor` and
 * `loctx status` can explain why a path was skipped.
 */

import {
  type Stats,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { Validator } from "./_validate.js";
import { FILTERING_DEFAULTS } from "./filtering-defaults.js";
import type { GitignoreSpec } from "./gitignore.js";
import type { Project } from "./models.js";

// ---- types --------------------------------------------------------------

export const FilterReason = {
  OK: "ok",
  OUTSIDE_PROJECT: "outside-project",
  IGNORED_DIRECTORY: "ignored-directory",
  IGNORED_BY_GITIGNORE: "ignored-by-gitignore",
  SYMLINK: "symlink",
  SECRET: "secret",
  UNSUPPORTED_EXTENSION: "unsupported-extension",
  OVERSIZED: "oversized",
  BINARY: "binary",
  UNREADABLE: "unreadable",
  MISSING: "missing",
  NOT_A_FILE: "not-a-file",
} as const;
export type FilterReason = (typeof FilterReason)[keyof typeof FilterReason];

export interface FilterDecision {
  readonly shouldIndex: boolean;
  readonly reason: FilterReason;
  readonly detail: string;
}

export interface FilteringRules {
  readonly maxFileSizeBytes: number;
  readonly followSymlinks: boolean;
  readonly ignoredDirs: ReadonlySet<string>;
  readonly secretGlobs: ReadonlyArray<string>;
  readonly secretAllowlistGlobs: ReadonlyArray<string>;
  readonly allowedExtensions: ReadonlySet<string>;
  readonly allowedNamedFiles: ReadonlySet<string>;
}

export class FilteringConfigError extends Error {}

// ---- loader -------------------------------------------------------------

const DEFAULT_OVERRIDE_DIR = join(homedir(), ".loctx", "config_overrides");
const BUNDLED_SOURCE_LABEL = "<bundled filtering defaults>";
const OVERRIDE_GLOBS = /\.ya?ml$/i;

const LIST_KEYS = [
  "ignored_dirs",
  "secret_globs",
  "secret_allowlist_globs",
  "allowed_extensions",
  "allowed_named_files",
] as const;
type ListKey = (typeof LIST_KEYS)[number];

const ALLOWED_TOP_KEYS = new Set<string>([
  ...LIST_KEYS,
  "max_file_size_bytes",
  "follow_symlinks",
  ...LIST_KEYS.map((k) => `remove_${k}`),
]);

interface Accumulator {
  maxFileSizeBytes: number;
  followSymlinks: boolean;
  lists: Record<ListKey, string[]>;
}

function newAccumulator(): Accumulator {
  return {
    maxFileSizeBytes: 1_048_576,
    followSymlinks: false,
    lists: {
      ignored_dirs: [],
      secret_globs: [],
      secret_allowlist_globs: [],
      allowed_extensions: [],
      allowed_named_files: [],
    },
  };
}

export interface LoadOptions {
  readonly overrideDir?: string;
}

export function loadFilteringRules(options: LoadOptions = {}): FilteringRules {
  // Baseline rules are an inlined TS literal (filtering-defaults.ts) — no FS
  // read at runtime. User overrides come from `~/.loctx/config_overrides/*`
  // (per-user YAML).
  const acc = mergeYaml(
    newAccumulator(),
    FILTERING_DEFAULTS as Record<string, unknown>,
    BUNDLED_SOURCE_LABEL,
  );
  for (const path of overrideFiles(options.overrideDir ?? DEFAULT_OVERRIDE_DIR)) {
    mergeYaml(acc, readYamlFile(path), path);
  }
  return finalize(acc);
}

function readYamlFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new FilteringConfigError(`Could not read ${path}: ${(err as Error).message}`);
  }
  return parseYamlText(text, path);
}

function parseYamlText(text: string, source: string): Record<string, unknown> {
  let loaded: unknown;
  try {
    // Same hardening as `config.ts`: disable merge keys and cap alias
    // expansion so a malicious `~/.loctx/config_overrides/*.yaml` can't
    // DoS the loader (#179).
    loaded = parseYaml(text, { merge: false, maxAliasCount: 100 });
  } catch (err) {
    throw new FilteringConfigError(`Invalid YAML in ${source}: ${(err as Error).message}`);
  }
  if (loaded === null || loaded === undefined) return {};
  return new Validator(FilteringConfigError, source).requireRecord(loaded, "top-level YAML");
}

function overrideFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!OVERRIDE_GLOBS.test(entry)) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    matches.push(full);
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

// ---- merging ------------------------------------------------------------

function mergeYaml(acc: Accumulator, data: Record<string, unknown>, source: string): Accumulator {
  const unknown = Object.keys(data).filter((k) => !ALLOWED_TOP_KEYS.has(k));
  if (unknown.length > 0) {
    throw new FilteringConfigError(
      `${source}: unknown filtering keys: ${unknown.sort().join(", ")}`,
    );
  }

  const v = new Validator(FilteringConfigError, source);

  const size = v.getInt(data, "max_file_size_bytes", { nonNegative: true });
  if (size !== undefined) acc.maxFileSizeBytes = size;

  const follow = v.getBool(data, "follow_symlinks");
  if (follow !== undefined) acc.followSymlinks = follow;

  for (const key of LIST_KEYS) {
    const extras = v.getStrArray(data, key);
    if (extras !== undefined) {
      acc.lists[key] = extendUnique(acc.lists[key], extras);
    }
    const removals = v.getStrArray(data, `remove_${key}`);
    if (removals !== undefined) {
      acc.lists[key] = subtract(acc.lists[key], removals);
    }
  }
  return acc;
}

function extendUnique<T>(items: Iterable<T>, extras: Iterable<T>): T[] {
  return [...new Set([...items, ...extras])];
}

function subtract<T>(items: Iterable<T>, removals: Iterable<T>): T[] {
  const drop = new Set(removals);
  return [...items].filter((item) => !drop.has(item));
}

function finalize(acc: Accumulator): FilteringRules {
  return Object.freeze({
    maxFileSizeBytes: acc.maxFileSizeBytes,
    followSymlinks: acc.followSymlinks,
    ignoredDirs: new Set(acc.lists.ignored_dirs),
    secretGlobs: Object.freeze([...acc.lists.secret_globs]),
    secretAllowlistGlobs: Object.freeze([...acc.lists.secret_allowlist_globs]),
    allowedExtensions: new Set(acc.lists.allowed_extensions.map(normalizeExt)),
    allowedNamedFiles: new Set(acc.lists.allowed_named_files),
  });
}

function normalizeExt(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

// ---- ProjectFilter ------------------------------------------------------

const BINARY_PROBE_BYTES = 8192;

export class ProjectFilter {
  constructor(
    public readonly project: Project,
    public readonly rules: FilteringRules,
    private readonly gitignore: GitignoreSpec | null = null,
  ) {}

  shouldIndex(path: string): FilterDecision {
    const absolute = isAbsolute(path) ? path : join(this.project.root, path);
    const rel = pathRelativeTo(this.project.root, absolute);
    if (rel === null) {
      return decide(
        false,
        FilterReason.OUTSIDE_PROJECT,
        `${absolute} is not under ${this.project.root}`,
      );
    }

    // ignored components (everything but the leaf name)
    const parts = rel.split("/");
    for (const component of parts.slice(0, -1)) {
      if (this.rules.ignoredDirs.has(component)) {
        return decide(false, FilterReason.IGNORED_DIRECTORY, component);
      }
    }

    if (this.gitignore?.ignores(rel)) {
      return decide(false, FilterReason.IGNORED_BY_GITIGNORE, rel);
    }

    const name = parts.at(-1) ?? rel;
    if (this.rules.ignoredDirs.has(name)) {
      return decide(false, FilterReason.IGNORED_DIRECTORY, name);
    }

    if (
      matchesAny(name, this.rules.secretGlobs) &&
      !matchesAny(name, this.rules.secretAllowlistGlobs)
    ) {
      return decide(false, FilterReason.SECRET, name);
    }

    if (!this.extensionAllowed(name)) {
      const suffix = extname(name) || "<no extension>";
      return decide(false, FilterReason.UNSUPPORTED_EXTENSION, suffix);
    }

    let stat: Stats;
    try {
      const lstat = lstatSync(absolute);
      if (lstat.isSymbolicLink() && !this.rules.followSymlinks) {
        return decide(false, FilterReason.SYMLINK, rel);
      }
      if (!existsSync(absolute)) {
        return decide(false, FilterReason.MISSING, rel);
      }
      stat = statSync(absolute);
      if (!stat.isFile()) return decide(false, FilterReason.NOT_A_FILE, rel);
    } catch (err) {
      return decide(false, FilterReason.UNREADABLE, (err as Error).message);
    }

    if (stat.size > this.rules.maxFileSizeBytes) {
      return decide(
        false,
        FilterReason.OVERSIZED,
        `${stat.size} bytes > ${this.rules.maxFileSizeBytes}`,
      );
    }

    try {
      if (looksBinary(absolute)) {
        return decide(false, FilterReason.BINARY, rel);
      }
    } catch (err) {
      return decide(false, FilterReason.UNREADABLE, (err as Error).message);
    }

    return decide(true, FilterReason.OK, "");
  }

  private extensionAllowed(name: string): boolean {
    if (this.rules.allowedNamedFiles.has(name)) return true;
    if (matchesAny(name, this.rules.secretAllowlistGlobs)) return true;
    const suffix = extname(name).toLowerCase();
    return suffix !== "" && this.rules.allowedExtensions.has(suffix);
  }
}

function decide(shouldIndex: boolean, reason: FilterReason, detail: string): FilterDecision {
  return Object.freeze({ shouldIndex, reason, detail });
}

function pathRelativeTo(root: string, absolute: string): string | null {
  const rel = relative(resolve(root), resolve(absolute));
  if (rel === "" || rel.startsWith("..")) return rel.startsWith("..") ? null : rel;
  return rel.split(sep).join("/");
}

function matchesAny(name: string, globs: ReadonlyArray<string>): boolean {
  return globs.some((pattern) => matchGlob(pattern, name));
}

/** fnmatch-equivalent: support `*` and `?` only — sufficient for the secret glob set. */
function matchGlob(pattern: string, name: string): boolean {
  const escaped = pattern
    .replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`).test(name);
}

function looksBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** Build a variant of `rules` with one or more fields replaced. Useful in tests. */
export function withOverrides(
  rules: FilteringRules,
  patch: Partial<FilteringRules>,
): FilteringRules {
  return Object.freeze({ ...rules, ...patch });
}
