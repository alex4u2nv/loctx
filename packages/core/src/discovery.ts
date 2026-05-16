/**
 * Workspace discovery and stable identity for projects, files, and chunks.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  type ChunkId,
  type FileId,
  type Project,
  type ProjectId,
  chunkId,
  fileId,
  projectId,
} from "./models.js";
import type { StateStore } from "./storage/state.js";

const DEFAULT_MAX_DEPTH = 4;
const PROJECT_ID_LEN = 16;
const FILE_ID_LEN = 16;
const CHUNK_HASH_LEN = 8;

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
 * similar build/dep cache traps. Keep in sync with the filtering
 * defaults; intentional duplication so discovery does not depend on
 * the chunker's filtering layer.
 */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  ".tox",
  ".cache",
  ".pnpm",
]);

/** Confidence ranking; lower number = higher confidence. */
const MARKER_RANK: Record<MarkerKind, number> = { git: 0, ide: 1, build: 2 };

/** Deterministic project id derived from the resolved absolute root path. */
export function projectIdFor(root: string): ProjectId {
  const canonical = resolve(root);
  const digest = createHash("sha1").update(canonical, "utf-8").digest("hex");
  return projectId(digest.slice(0, PROJECT_ID_LEN));
}

export function fileIdFor(project: Project, relPath: string): FileId {
  const rel = relPath.replaceAll("\\", "/");
  const digest = createHash("sha1").update(`${project.id}:${rel}`, "utf-8").digest("hex");
  return fileId(digest.slice(0, FILE_ID_LEN));
}

export function chunkIdFor(
  fid: FileId,
  startLine: number,
  endLine: number,
  contentSha: string,
): ChunkId {
  const short = contentSha.slice(0, CHUNK_HASH_LEN);
  return chunkId(`${fid}:${pad(startLine)}-${pad(endLine)}:${short}`);
}

function pad(n: number): string {
  return n.toString().padStart(6, "0");
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
}

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

  constructor(workspaceRoots: Iterable<string>, options: DiscoveryOptions = {}) {
    this.roots = Object.freeze(
      [...workspaceRoots].map((r) => resolveSafe(r)).filter((r): r is string => r !== null),
    );
    this.maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
    this.markers = options.markers ?? DEFAULT_PROJECT_MARKERS;
  }

  get configuredRoots(): ReadonlyArray<string> {
    return this.roots;
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
   */
  discoverWithMarkers(): DiscoveryHit[] {
    const seen = new Map<string, DiscoveryHit>();
    for (const root of this.roots) {
      if (!isDir(root)) continue;
      for (const hit of this.iterProjectHits(root, 0)) {
        if (!seen.has(hit.project.id)) seen.set(hit.project.id, hit);
      }
    }
    return [...seen.values()].sort((a, b) => a.project.root.localeCompare(b.project.root));
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
    let entries: string[] | null = null;
    let best: MarkerSpec | null = null;
    for (const spec of this.markers) {
      if (spec.kind === "dir") {
        if (isDir(join(directory, spec.name))) {
          best = bestOf(best, spec);
        }
      } else if (spec.kind === "file") {
        if (isFile(join(directory, spec.name))) {
          best = bestOf(best, spec);
        }
      } else if (spec.kind === "fileSuffix") {
        if (entries === null) {
          try {
            entries = readdirSync(directory);
          } catch {
            entries = [];
          }
        }
        if (entries.some((n) => n.endsWith(spec.name))) {
          best = bestOf(best, spec);
        }
      }
    }
    return best;
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

// ---- active / inactive / orphaned categorization -----------------------

export interface ActiveProject {
  readonly project: Project;
  readonly lastIndexedAt: string | null;
  readonly lastReconciledAt: string | null;
  /** Marker filename/dirname that identified this directory as a project. */
  readonly marker: string;
  readonly markerKind: MarkerKind;
}

/**
 * Discovered under `workspace_roots` but the user hasn't activated it.
 * Indexer/watcher/reconciler skip these; UI surfaces them with an
 * "Activate" affordance.
 */
export interface InactiveProject {
  readonly project: Project;
  readonly marker: string;
  readonly markerKind: MarkerKind;
  /** True when a state row already exists with active=0 (vs. never recorded). */
  readonly known: boolean;
}

export interface OrphanedProject {
  readonly project: Project;
  readonly lastIndexedAt: string | null;
  readonly lastReconciledAt: string | null;
  /** False if the recorded `root` no longer exists on disk. */
  readonly rootExists: boolean;
  /**
   * Why this project is no longer active. "outside-roots" — recorded root
   * isn't reachable from any configured workspace_root. "missing" — recorded
   * root path doesn't exist on disk anymore.
   */
  readonly reason: "outside-roots" | "missing";
}

export interface ProjectInventory {
  readonly active: ReadonlyArray<ActiveProject>;
  readonly inactive: ReadonlyArray<InactiveProject>;
  readonly orphaned: ReadonlyArray<OrphanedProject>;
}

/**
 * Categorise every project the daemon knows about into three buckets:
 *
 *   - **active**: discovered under `workspace_roots` AND has a state row
 *     with `active=1`. These are the ones the indexer / watcher /
 *     reconciler operate on.
 *   - **inactive**: discovered AND (no state row OR `active=0`). User
 *     hasn't opted in yet; they show up in the UI with an "Activate"
 *     button.
 *   - **orphaned**: in state but no longer discoverable. Either
 *     `workspace_roots` shrank ("outside-roots") or the directory was
 *     deleted on disk ("missing"). Search still hits these; nothing
 *     else does.
 */
export function inventoryProjects(
  discovery: WorkspaceDiscovery,
  state: StateStore,
): ProjectInventory {
  const recorded = state.listProjects();
  const recordedById = new Map(recorded.map((r) => [r.id, r]));
  const discovered = discovery.discoverWithMarkers();
  const discoveredIds = new Set(discovered.map((h) => h.project.id));

  const active: ActiveProject[] = [];
  const inactive: InactiveProject[] = [];

  for (const hit of discovered) {
    const r = recordedById.get(hit.project.id);
    if (r?.active) {
      active.push({
        project: hit.project,
        lastIndexedAt: r.lastIndexedAt,
        lastReconciledAt: r.lastReconciledAt,
        marker: hit.marker,
        markerKind: hit.markerKind,
      });
    } else {
      inactive.push({
        project: hit.project,
        marker: hit.marker,
        markerKind: hit.markerKind,
        known: r !== undefined,
      });
    }
  }

  const orphaned: OrphanedProject[] = recorded
    .filter((r) => !discoveredIds.has(r.id))
    .map((r) => {
      const rootExists = isDir(r.root);
      return {
        project: { id: r.id, name: r.name, root: r.root },
        lastIndexedAt: r.lastIndexedAt,
        lastReconciledAt: r.lastReconciledAt,
        rootExists,
        reason: rootExists ? ("outside-roots" as const) : ("missing" as const),
      };
    })
    // Stable ordering: orphaned by root path.
    .sort((a, b) => a.project.root.localeCompare(b.project.root));

  return Object.freeze({
    active: Object.freeze(active),
    inactive: Object.freeze(inactive),
    orphaned: Object.freeze(orphaned),
  });
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
