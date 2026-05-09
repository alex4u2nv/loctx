/**
 * Workspace search over the local LanceDB index.
 *
 * Scope is driven by a single optional `path` parameter — a file or
 * directory anywhere on disk. The searcher resolves it against the
 * indexed projects:
 *
 *   - omitted              → search every indexed project ("all")
 *   - path is a project root → project-scoped search
 *   - path is inside a project → project + path-prefix subtree filter
 *   - path is outside every indexed project → warn, fall back to "all"
 *
 * Path is the natural primitive for coding agents (they always have a
 * file path or working directory) and avoids the "look up project id
 * first" round-trip.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceDiscovery } from "../discovery.js";
import type { EmbeddingProvider } from "../embeddings/index.js";
import type { Project } from "../models.js";
import type { VectorStore } from "../storage/index.js";

/** What kind of slice the searcher applied. Reported back on the response. */
export type Scope = "all" | "project" | "subtree";

export interface SearchRequest {
  readonly query: string;
  /**
   * Absolute file or directory path. Optional; when omitted the search
   * spans every indexed project. Relative paths are resolved against
   * `process.cwd()` for CLI ergonomics.
   */
  readonly path?: string;
  readonly limit?: number;
  readonly language?: string;
}

export interface ResolvedScope {
  readonly mode: Scope;
  readonly project: Project | null;
  /** Path-prefix relative to {@link project.root}, or null. */
  readonly relPrefix: string | null;
  /** Absolute form of the input path after resolution, or null. */
  readonly inputPath: string | null;
}

export interface SearchResult {
  readonly projectId: string;
  readonly projectName: string;
  /** Absolute project root, or null if the project is no longer on disk. */
  readonly projectRoot: string | null;
  /** Path relative to {@link projectRoot}. Always present. */
  readonly relPath: string;
  /**
   * Absolute filesystem path. Null only when the project that produced this
   * chunk has been removed from `workspace_roots` since indexing — the chunk
   * still scores, but the resolver has no current root to glue onto relPath.
   */
  readonly absPath: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly snippet: string;
  readonly language: string;
  readonly kind: string;
  readonly symbols: ReadonlyArray<string>;
}

export interface SearchResponse {
  readonly resolvedScope: ResolvedScope;
  readonly results: ReadonlyArray<SearchResult>;
  readonly warnings: ReadonlyArray<string>;
}

export class SearcherError extends Error {}

export class WorkspaceSearcher {
  constructor(
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly discovery: WorkspaceDiscovery,
  ) {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    const limit = Math.max(1, request.limit ?? 10);
    const warnings: string[] = [];
    const scope = this.resolveScope(request, warnings);

    const where = buildWhere(scope, request.language);
    const embedding = await this.embeddings.embedQuery(request.query);
    const matches = await this.vectors.query({
      embedding,
      k: limit,
      ...(where !== null ? { where } : {}),
    });

    // Build a projectId → Project map so each result can carry its absolute
    // root. The cost is one extra discovery pass, which is cached by the
    // discovery layer.
    const projectsById = new Map<string, Project>();
    for (const p of this.discovery.discoverProjects()) projectsById.set(p.id, p);

    let results: SearchResult[] = matches.map((m) => toResult(m, projectsById));
    if (scope.relPrefix !== null) {
      // Subtree post-filter. We could push this into the SQL `where` with
      // `starts_with(rel_path, ?)`, but doing it host-side keeps the
      // per-backend predicate surface minimal.
      results = results.filter((r) => r.relPath.startsWith(scope.relPrefix as string));
    }
    results = results.slice(0, limit);

    return Object.freeze({
      resolvedScope: scope,
      results: Object.freeze(results),
      warnings: Object.freeze(warnings),
    });
  }

  private resolveScope(request: SearchRequest, warnings: string[]): ResolvedScope {
    if (request.path === undefined) {
      return Object.freeze({ mode: "all", project: null, relPrefix: null, inputPath: null });
    }

    const absPath = isAbsolute(request.path) ? request.path : resolve(request.path);
    const project = this.discovery.resolveProject(absPath);
    if (project === null) {
      warnings.push(`path ${absPath} is not inside any indexed project; searching every project.`);
      return Object.freeze({ mode: "all", project: null, relPrefix: null, inputPath: absPath });
    }

    // The path lands inside a project. If the path is the root itself, scope
    // to the whole project; if it's deeper, treat the leftover as a subtree
    // prefix the post-filter applies.
    const rel = relative(resolve(project.root), absPath).split(sep).join("/");
    if (rel === "" || rel === ".") {
      return Object.freeze({ mode: "project", project, relPrefix: null, inputPath: absPath });
    }
    if (rel.startsWith("..")) {
      // Defensive — `resolveProject` claimed this path, but the relative
      // form escapes. Treat as project scope and warn.
      warnings.push(
        `resolved project ${project.root} doesn't contain ${absPath}; falling back to project scope.`,
      );
      return Object.freeze({ mode: "project", project, relPrefix: null, inputPath: absPath });
    }
    return Object.freeze({
      mode: "subtree",
      project,
      relPrefix: `${rel}/`,
      inputPath: absPath,
    });
  }
}

// ---- helpers -----------------------------------------------------------

function buildWhere(scope: ResolvedScope, language?: string): string | null {
  const clauses: string[] = [];
  if (scope.project !== null) clauses.push(`project_id = ${quoteSql(scope.project.id)}`);
  if (language) clauses.push(`language = ${quoteSql(language)}`);
  if (clauses.length === 0) return null;
  return clauses.join(" AND ");
}

function quoteSql(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function toResult(
  match: {
    chunkId: string;
    score: number;
    metadata: Readonly<Record<string, unknown>>;
    document: string;
  },
  projectsById: ReadonlyMap<string, Project>,
): SearchResult {
  const meta = match.metadata;
  const symbolsRaw = meta["symbols"];
  const symbols =
    typeof symbolsRaw === "string" && symbolsRaw.length > 0
      ? Object.freeze(symbolsRaw.split(",").filter((s) => s !== ""))
      : Object.freeze([]);
  const projectId = String(meta["project_id"] ?? "");
  const relPath = String(meta["rel_path"] ?? "");
  const project = projectsById.get(projectId) ?? null;
  return Object.freeze({
    projectId,
    projectName: project?.name ?? "",
    projectRoot: project?.root ?? null,
    relPath,
    absPath: project !== null && relPath !== "" ? join(project.root, relPath) : null,
    startLine: Number(meta["start_line"] ?? 0),
    endLine: Number(meta["end_line"] ?? 0),
    score: match.score,
    snippet: match.document,
    language: String(meta["language"] ?? ""),
    kind: String(meta["kind"] ?? ""),
    symbols,
  });
}
