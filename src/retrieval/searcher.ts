/**
 * Workspace search over the local Chroma index.
 *
 * Scope semantics:
 *   - "all":     no project filter; query the entire collection.
 *   - "auto":    resolve cwd to nearest project; if none, fall back to "all" with warning.
 *   - "project": resolve cwd to nearest project; error if none.
 *   - "subtree": same as "project" plus a relative-path prefix from cwd.
 */

import { relative, resolve, sep } from "node:path";
import type { WorkspaceDiscovery } from "../discovery.js";
import type { EmbeddingProvider } from "../embeddings/index.js";
import type { Project } from "../models.js";
import type { VectorStore } from "../storage/index.js";

export type Scope = "auto" | "project" | "subtree" | "all";

export interface SearchRequest {
  readonly query: string;
  readonly cwd?: string;
  readonly scope?: Scope;
  readonly limit?: number;
  readonly language?: string;
}

export interface ResolvedScope {
  readonly mode: Scope;
  readonly project: Project | null;
  readonly relPrefix: string | null;
}

export interface SearchResult {
  readonly projectId: string;
  readonly relPath: string;
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

    let results: SearchResult[] = matches.map(toResult);
    if (scope.relPrefix !== null) {
      // subtree post-filter: Chroma's where-clause doesn't support prefix matches.
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
    const requested: Scope = request.scope ?? "auto";
    if (requested === "all") {
      return Object.freeze({ mode: "all", project: null, relPrefix: null });
    }

    const cwd = resolve(request.cwd ?? process.cwd());
    const project = this.discovery.resolveProject(cwd);

    if (requested === "auto") {
      if (project === null) {
        warnings.push("No project found for cwd; searching all indexed projects.");
        return Object.freeze({ mode: "all", project: null, relPrefix: null });
      }
      return Object.freeze({ mode: "project", project, relPrefix: null });
    }

    if (project === null) {
      throw new SearcherError(
        `--scope ${requested} requires a project root, but no .git/ was found at or above ${cwd}.`,
      );
    }

    if (requested === "project") {
      return Object.freeze({ mode: "project", project, relPrefix: null });
    }

    // subtree
    const rel = relative(resolve(project.root), cwd).split(sep).join("/");
    if (rel.startsWith("..")) {
      warnings.push(
        `cwd ${cwd} is outside resolved project ${project.root}; falling back to project scope.`,
      );
      return Object.freeze({ mode: "project", project, relPrefix: null });
    }
    const prefix = rel === "" || rel === "." ? null : `${rel}/`;
    return Object.freeze({ mode: "subtree", project, relPrefix: prefix });
  }
}

// ---- helpers -----------------------------------------------------------

function buildWhere(scope: ResolvedScope, language?: string): Record<string, unknown> | null {
  const clauses: Record<string, unknown>[] = [];
  if (scope.project !== null) clauses.push({ project_id: scope.project.id });
  if (language) clauses.push({ language });
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0] ?? null;
  return { $and: clauses };
}

function toResult(match: {
  chunkId: string;
  score: number;
  metadata: Readonly<Record<string, unknown>>;
  document: string;
}): SearchResult {
  const meta = match.metadata;
  const symbolsRaw = meta["symbols"];
  const symbols =
    typeof symbolsRaw === "string" && symbolsRaw.length > 0
      ? Object.freeze(symbolsRaw.split(",").filter((s) => s !== ""))
      : Object.freeze([]);
  return Object.freeze({
    projectId: String(meta["project_id"] ?? ""),
    relPath: String(meta["rel_path"] ?? ""),
    startLine: Number(meta["start_line"] ?? 0),
    endLine: Number(meta["end_line"] ?? 0),
    score: match.score,
    snippet: match.document,
    language: String(meta["language"] ?? ""),
    kind: String(meta["kind"] ?? ""),
    symbols,
  });
}
