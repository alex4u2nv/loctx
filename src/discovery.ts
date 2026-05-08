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

const PROJECT_MARKER = ".git";
const DEFAULT_MAX_DEPTH = 4;
const PROJECT_ID_LEN = 16;
const FILE_ID_LEN = 16;
const CHUNK_HASH_LEN = 8;

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
  const resolved = resolve(root);
  return {
    id: projectIdFor(resolved),
    name: resolved.split(sep).pop() ?? resolved,
    root: resolved,
  };
}

export interface DiscoveryOptions {
  readonly maxDepth?: number;
}

export class WorkspaceDiscovery {
  private readonly roots: ReadonlyArray<string>;
  private readonly maxDepth: number;

  constructor(workspaceRoots: Iterable<string>, options: DiscoveryOptions = {}) {
    this.roots = Object.freeze(
      [...workspaceRoots].map((r) => resolveSafe(r)).filter((r): r is string => r !== null),
    );
    this.maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  }

  get configuredRoots(): ReadonlyArray<string> {
    return this.roots;
  }

  /** Discover every project under configured roots. Dedupe by id, sort by root path. */
  discoverProjects(): Project[] {
    const seen = new Map<string, Project>();
    for (const root of this.roots) {
      if (!isDir(root)) continue;
      for (const projectRoot of this.iterProjectRoots(root, 0)) {
        const project = makeProject(projectRoot);
        if (!seen.has(project.id)) seen.set(project.id, project);
      }
    }
    return [...seen.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  /** Walk upward from cwd looking for the nearest `.git/` directory. */
  resolveProject(cwd: string): Project | null {
    let current = resolveSafe(cwd);
    if (current === null) return null;
    if (existsSync(current) && lstatSync(current).isFile()) {
      current = dirname(current);
    }
    let last = "";
    while (current !== last) {
      if (isDir(join(current, PROJECT_MARKER))) {
        return makeProject(current);
      }
      last = current;
      current = dirname(current);
    }
    return null;
  }

  private *iterProjectRoots(directory: string, depth: number): Generator<string> {
    if (isDir(join(directory, PROJECT_MARKER))) {
      yield directory;
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
      if (name.startsWith(".")) continue;
      const child = join(directory, name);
      try {
        const stat = lstatSync(child);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      yield* this.iterProjectRoots(child, depth + 1);
    }
  }
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
