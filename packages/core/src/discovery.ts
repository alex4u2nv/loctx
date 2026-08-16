/**
 * Workspace discovery and stable identity for projects, files, and chunks.
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { projectIdFor } from "./discovery-ids.js";
import type { AbsorbedMarker } from "./discovery-inventory.js";
import { IGNORED_DIR_NAMES } from "./filtering-defaults.js";
import type { Project } from "./models.js";

const DEFAULT_MAX_DEPTH = 4;

/**
 * Project root markers, ordered by confidence. The first matching marker
 * at a directory wins; markers higher in this list outrank lower ones.
 *
 *   - **git**: `.git/`. Highest confidence.
 *   - **ide**: an IDE has registered the directory as a workspace root.
 *   - **build**: a build/package manifest exists. Lowest confidence;
 *     `package.json` lives in too many `node_modules/*` to be reliable
 *     on its own. The ignored-dirs filter below keeps those out.
 */
export type MarkerKind = "git" | "ide" | "build";

export interface MarkerSpec {
  /** Filename or directory name, or a suffix pattern like `.code-workspace`. */
  readonly name: string;
  /** Whether to test by exact name (file/dir) or by suffix-of-filename match. */
  readonly kind: "dir" | "file" | "fileSuffix";
  readonly group: MarkerKind;
}

export const DEFAULT_PROJECT_MARKERS: ReadonlyArray<MarkerSpec> = Object.freeze([
  { name: ".git", kind: "dir", group: "git" },
  { name: ".idea", kind: "dir", group: "ide" },
  { name: ".vscode", kind: "dir", group: "ide" },
  { name: ".code-workspace", kind: "fileSuffix", group: "ide" },
  { name: "package.json", kind: "file", group: "build" },
  { name: "pyproject.toml", kind: "file", group: "build" },
  { name: "Cargo.toml", kind: "file", group: "build" },
  { name: "go.mod", kind: "file", group: "build" },
  { name: "pom.xml", kind: "file", group: "build" },
  { name: "build.gradle", kind: "file", group: "build" },
  { name: "build.gradle.kts", kind: "file", group: "build" },
  { name: "Makefile", kind: "file", group: "build" },
  { name: "CMakeLists.txt", kind: "file", group: "build" },
]);

/**
 * Directories never treated as project roots regardless of markers
 * found inside them. Avoids `node_modules/<pkg>/package.json` and
 * similar build/dep cache traps. Derived from the canonical
 * filtering-defaults name list (CORE-12 — this used to be a third
 * hand-maintained copy that had drifted), plus discovery-specific
 * extras: `vendor` (Go/PHP dependency trees full of foreign
 * package.json / go.mod markers) and `.pnpm` (pnpm's virtual store,
 * already covered by the dot-dir skip in the walker but kept explicit).
 */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([...IGNORED_DIR_NAMES, "vendor", ".pnpm"]);

/** Confidence ranking; lower number = higher confidence. */
const MARKER_RANK: Record<MarkerKind, number> = { git: 0, ide: 1, build: 2 };

/**
 * Standalone version of {@link WorkspaceDiscovery.resolveProject} —
 * usable by callers (notably the CLI's `add`/`pause`/etc. commands)
 * that need to map a cwd to a project without first building a full
 * runtime. Always uses {@link DEFAULT_PROJECT_MARKERS}; callers that
 * need custom markers should construct a WorkspaceDiscovery.
 */
export function findContainingProject(start: string): Project | null {
  let current = resolveSafe(start);
  if (current === null) return null;
  if (existsSync(current) && lstatSync(current).isFile()) {
    current = dirname(current);
  }
  let last = "";
  while (current !== last) {
    if (detectMarkerAt(current, DEFAULT_PROJECT_MARKERS) !== null) {
      return makeProject(current);
    }
    last = current;
    current = dirname(current);
  }
  return null;
}

function detectMarkerAt(directory: string, markers: ReadonlyArray<MarkerSpec>): MarkerSpec | null {
  let entries: string[] | null = null;
  let best: MarkerSpec | null = null;
  for (const spec of markers) {
    if (spec.kind === "dir") {
      if (isDir(join(directory, spec.name))) best = bestOf(best, spec);
    } else if (spec.kind === "file") {
      if (isFile(join(directory, spec.name))) best = bestOf(best, spec);
    } else if (spec.kind === "fileSuffix") {
      if (entries === null) {
        try {
          entries = readdirSync(directory);
        } catch {
          entries = [];
        }
      }
      if (entries.some((n) => n.endsWith(spec.name))) best = bestOf(best, spec);
    }
  }
  return best;
}

export function makeProject(root: string): Project {
  // Realpath when possible — `discovery.resolveProject` walks via realpath,
  // and any symlink mismatch between the CLI's `--path` argument and the
  // indexed project root produces a different ProjectId at search time.
  // macOS `/var/folders` → `/private/var/folders` is the common offender.
  // Fall back to resolve() when the path doesn't exist on disk yet (e.g.
  // synthetic paths in tests).
  let resolved: string;
  try {
    resolved = realpathSync(resolve(root));
  } catch {
    resolved = resolve(root);
  }
  return {
    id: projectIdFor(resolved),
    name: resolved.split(sep).pop() ?? resolved,
    root: resolved,
  };
}

export interface DiscoveryOptions {
  readonly maxDepth?: number;
  /**
   * Override the marker list. Use to extend, restrict, or re-order the
   * defaults. First-matching, group-ranked precedence still applies.
   */
  readonly markers?: ReadonlyArray<MarkerSpec>;
  /**
   * How long a {@link WorkspaceDiscovery.discoverWithMarkers} result is
   * reused before the workspace roots are walked again. The walk is
   * synchronous filesystem I/O over every root to `maxDepth`, and it sits
   * on the search hot path (#443) — without a cache every search pays it.
   * `0` disables caching. Callers that mutate the project set (index,
   * refresh, activate) should call {@link WorkspaceDiscovery.invalidate}
   * rather than rely on expiry.
   */
  readonly cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 10_000;

/**
 * A project plus the marker that identified it. Returned by
 * {@link WorkspaceDiscovery.discoverWithMarkers}; surfaced in
 * `loctx doctor`, the admin UI's projects page, and MCP
 * `workspace_status`.
 */
export interface DiscoveryHit {
  readonly project: Project;
  /** Filename or directory name of the matched marker (e.g. `.git`, `package.json`). */
  readonly marker: string;
  /** Marker confidence group. */
  readonly markerKind: MarkerKind;
}

export class WorkspaceDiscovery {
  private readonly roots: ReadonlyArray<string>;
  private readonly maxDepth: number;
  private readonly markers: ReadonlyArray<MarkerSpec>;
  private readonly cacheTtlMs: number;
  private cached: { hits: ReadonlyArray<DiscoveryHit>; expiresAt: number } | null = null;

  constructor(workspaceRoots: Iterable<string>, options: DiscoveryOptions = {}) {
    this.roots = Object.freeze(
      [...workspaceRoots].map((r) => resolveSafe(r)).filter((r): r is string => r !== null),
    );
    this.maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
    this.markers = options.markers ?? DEFAULT_PROJECT_MARKERS;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  }

  get configuredRoots(): ReadonlyArray<string> {
    return this.roots;
  }

  /**
   * Drop the cached walk result. Call after any operation that changes
   * the project set — activating/adding a project, `refresh_workspace`,
   * a full index pass — so the next discovery reflects the mutation
   * immediately instead of after TTL expiry.
   */
  invalidate(): void {
    this.cached = null;
  }

  /** Discover every project under configured roots. Dedupe by id, sort by root path. */
  discoverProjects(): Project[] {
    return this.discoverWithMarkers().map((h) => h.project);
  }

  /**
   * Like {@link discoverProjects} but each entry includes the marker
   * that identified the directory as a project. Useful for status,
   * doctor, and admin UI surfaces that explain *why* a directory was
   * picked up.
   *
   * Results are served from a short-TTL cache (see
   * {@link DiscoveryOptions.cacheTtlMs}) because this walk is
   * synchronous I/O on the search hot path. A fresh shallow copy is
   * returned each call so callers can sort/filter freely.
   */
  discoverWithMarkers(): DiscoveryHit[] {
    if (this.cached !== null && Date.now() < this.cached.expiresAt) {
      return [...this.cached.hits];
    }
    const seen = new Map<string, DiscoveryHit>();
    for (const root of this.roots) {
      if (!isDir(root)) continue;
      for (const hit of this.iterProjectHits(root, 0)) {
        if (!seen.has(hit.project.id)) seen.set(hit.project.id, hit);
      }
    }
    const hits = [...seen.values()].sort((a, b) => a.project.root.localeCompare(b.project.root));
    if (this.cacheTtlMs > 0) {
      this.cached = { hits: Object.freeze([...hits]), expiresAt: Date.now() + this.cacheTtlMs };
    }
    return hits;
  }

  // Inner project markers absorbed by a parent project (#286). Walks the
  // subtree under `projectRoot` with the same maxDepth + skip rules as
  // discovery, collecting marker-bearing subdirectories. Stops descending
  // once an inner marker is hit so we surface direct children only, not
  // markers inside those children.
  findAbsorbedMarkers(projectRoot: string): AbsorbedMarker[] {
    const root = resolveSafe(projectRoot);
    if (root === null || !isDir(root)) return [];
    const out: AbsorbedMarker[] = [];
    for (const hit of this.iterAbsorbedInside(root, 0)) {
      const path = hit.path;
      const relPath = relative(root, path).split(sep).join("/");
      out.push({ path, relPath, marker: hit.marker, markerKind: hit.markerKind });
    }
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return out;
  }

  private *iterAbsorbedInside(
    directory: string,
    depth: number,
  ): Generator<{ path: string; marker: string; markerKind: MarkerKind }> {
    if (depth > 0) {
      const marker = this.detectMarker(directory);
      if (marker !== null) {
        yield { path: directory, marker: marker.name, markerKind: marker.group };
        return;
      }
    }
    if (depth >= this.maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || SKIP_DIR_NAMES.has(name)) continue;
      const child = join(directory, name);
      try {
        const stat = lstatSync(child);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      yield* this.iterAbsorbedInside(child, depth + 1);
    }
  }

  /** Walk upward from cwd looking for the nearest project marker. */
  resolveProject(cwd: string): Project | null {
    let current = resolveSafe(cwd);
    if (current === null) return null;
    if (existsSync(current) && lstatSync(current).isFile()) {
      current = dirname(current);
    }
    let last = "";
    while (current !== last) {
      if (this.detectMarker(current) !== null) {
        return makeProject(current);
      }
      last = current;
      current = dirname(current);
    }
    return null;
  }

  private *iterProjectHits(directory: string, depth: number): Generator<DiscoveryHit> {
    const marker = this.detectMarker(directory);
    if (marker !== null) {
      yield { project: makeProject(directory), marker: marker.name, markerKind: marker.group };
      return; // do not descend into a project's subdirectories
    }
    if (depth >= this.maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      return;
    }

    for (const name of entries) {
      // Skip dotfiles (won't match dir markers since those start with `.`
      // but are added below) and known build/cache directories so we
      // don't descend into `node_modules/<pkg>/package.json`.
      if (name.startsWith(".") || SKIP_DIR_NAMES.has(name)) continue;
      const child = join(directory, name);
      try {
        const stat = lstatSync(child);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      yield* this.iterProjectHits(child, depth + 1);
    }
  }

  /**
   * Return the highest-ranked marker present at `directory`, or null if
   * none. Higher-ranked marker groups (git → ide → build) win over
   * lower-ranked, regardless of declaration order.
   */
  private detectMarker(directory: string): MarkerSpec | null {
    return detectMarkerAt(directory, this.markers);
  }
}

function bestOf(a: MarkerSpec | null, b: MarkerSpec): MarkerSpec {
  if (a === null) return b;
  return MARKER_RANK[a.group] <= MARKER_RANK[b.group] ? a : b;
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

// ---- workspace containment ---------------------------------------------

/**
 * Resolve `path` and verify it is a descendant of (or equal to) one of
 * the configured `workspaceRoots`. Returns the canonical resolved path
 * on success, null on failure.
 *
 * Used by HTTP/MCP handlers that accept a `path` parameter to prevent a
 * local attacker (on loopback) from triggering work against arbitrary
 * filesystem paths like `/etc`, `~/Library`, or another user's home.
 *
 * - Resolves both the input and each root via `realpathSync` when they
 *   exist; falls back to `resolve()` otherwise. This catches symlink
 *   escapes (`~/Workspaces/escape -> /etc`).
 * - Containment is a strict path-prefix check on the canonical form, so
 *   `~/Workspaces/foo` containing `~/Workspaces/foobar` correctly
 *   rejects the latter (no partial-prefix matches).
 * - Path equality counts as "under" — a workspace root itself is a
 *   valid project path.
 */
export function resolveUnderWorkspaceRoots(
  path: string,
  workspaceRoots: ReadonlyArray<string>,
): string | null {
  const target = resolveSafe(path);
  if (target === null) return null;
  for (const root of workspaceRoots) {
    const canonicalRoot = resolveSafe(root);
    if (canonicalRoot === null) continue;
    if (target === canonicalRoot) return target;
    // Append `sep` so `/foo/barbaz` is not considered under `/foo/bar`.
    if (target.startsWith(canonicalRoot + sep)) return target;
  }
  return null;
}

// ---- helpers -----------------------------------------------------------

function resolveSafe(path: string): string | null {
  try {
    const expanded = expandHome(path);
    return realpathSync(expanded);
  } catch {
    try {
      return resolve(expandHome(path));
    } catch {
      return null;
    }
  }
}

function expandHome(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    const home = process.env["HOME"] ?? "";
    return home + path.slice(1);
  }
  return path;
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Re-exports (#542 split): existing importers keep working through
// discovery.ts.
export { chunkIdFor, fileIdFor, projectIdFor } from "./discovery-ids.js";
export * from "./discovery-inventory.js";
