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

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectLanguage } from "../chunking/index.js";
import type { RetrievalConfig } from "../config.js";
import type { WorkspaceDiscovery } from "../discovery.js";
import type { EmbeddingProvider } from "../embeddings/index.js";
import type { Project } from "../models.js";
import type { LexicalMatch, StateStore, VectorMatch, VectorStore } from "../storage/index.js";

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

/**
 * Which retrieval branches contributed to a result. `vector` is dense
 * cosine similarity over LanceDB, `lexical` is BM25 over SQLite FTS5.
 * Most results in hybrid mode carry both.
 */
export type RetrievalSource = "vector" | "lexical";

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
  /** Fused RRF score in hybrid mode; raw branch score otherwise. Higher is better. */
  readonly score: number;
  readonly snippet: string;
  readonly language: string;
  readonly kind: string;
  readonly symbols: ReadonlyArray<string>;
  /** Branches that contributed to this result. */
  readonly sources: ReadonlyArray<RetrievalSource>;
}

export interface SearchResponse {
  readonly resolvedScope: ResolvedScope;
  readonly results: ReadonlyArray<SearchResult>;
  readonly warnings: ReadonlyArray<string>;
}

export class SearcherError extends Error {}

/** Reciprocal Rank Fusion constant. 60 is the literature default. */
export const DEFAULT_RRF_K = 60;
/**
 * How much we over-fetch from each branch before fusing. Without it,
 * a chunk that ranks 11th in vector but 3rd in lexical can be dropped
 * because vector returns only `limit` rows.
 */
const OVER_FETCH_FACTOR = 5;

const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = Object.freeze({
  mode: "hybrid",
  rrfK: DEFAULT_RRF_K,
});

export class WorkspaceSearcher {
  private readonly retrieval: RetrievalConfig;

  constructor(
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly discovery: WorkspaceDiscovery,
    private readonly state: StateStore,
    retrieval: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  ) {
    this.retrieval = retrieval;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const limit = Math.max(1, request.limit ?? 10);
    const warnings: string[] = [];
    const scope = this.resolveScope(request, warnings);
    const fetchK = limit * OVER_FETCH_FACTOR;

    // Each branch is fired only when the active mode includes it. Vector-
    // only and lexical-only modes skip the other branch entirely so we
    // don't pay for an embedding inference (or an FTS5 round-trip) we'll
    // ignore.
    const wantsVector = this.retrieval.mode !== "lexical";
    const wantsLexical = this.retrieval.mode !== "vector";

    const [matches, lexicalMatches] = await Promise.all([
      wantsVector ? this.runVectorBranch(request, scope, fetchK) : Promise.resolve([]),
      wantsLexical ? this.runLexicalBranch(request, scope, fetchK) : Promise.resolve([]),
    ]);

    // Build a projectId → Project map so each result can carry its absolute
    // root. One discovery pass; cached by the discovery layer.
    const projectsById = new Map<string, Project>();
    for (const p of this.discovery.discoverProjects()) projectsById.set(p.id, p);

    const fused = rrfFuse(matches, lexicalMatches, this.retrieval.rrfK).slice(0, limit);

    const vectorById = new Map(matches.map((m) => [m.chunkId, m]));
    const lexicalById = new Map(lexicalMatches.map((m) => [m.chunkId, m]));

    const results: SearchResult[] = fused.map((entry) => {
      const v = vectorById.get(entry.chunkId);
      const l = lexicalById.get(entry.chunkId);
      return assembleResult(entry, v, l, projectsById);
    });

    return Object.freeze({
      resolvedScope: scope,
      results: Object.freeze(results),
      warnings: Object.freeze(warnings),
    });
  }

  private async runVectorBranch(
    request: SearchRequest,
    scope: ResolvedScope,
    k: number,
  ): Promise<VectorMatch[]> {
    const where = buildVectorWhere(scope, request.language);
    const embedding = await this.embeddings.embedQuery(request.query);
    return this.vectors.query({
      embedding,
      k,
      ...(where !== null ? { where } : {}),
    });
  }

  private async runLexicalBranch(
    request: SearchRequest,
    scope: ResolvedScope,
    k: number,
  ): Promise<LexicalMatch[]> {
    const ftsQuery = toFtsExpression(request.query);
    if (ftsQuery === "") return [];
    try {
      const matches = this.state.searchLexical({
        query: ftsQuery,
        limit: k,
        ...(scope.project !== null ? { projectId: scope.project.id } : {}),
        ...(scope.relPrefix !== null ? { relPathPrefix: scope.relPrefix } : {}),
      });
      // Language filter is post-filter: it isn't stored on chunks_fts.
      // Derived from rel_path via the same dispatcher the chunker uses, so
      // the predicate matches what's in the vector metadata.
      if (request.language === undefined) return matches;
      return matches.filter((m) => detectLanguage(m.relPath) === request.language);
    } catch (err) {
      // FTS5 syntax errors (e.g., unbalanced quotes in user input) shouldn't
      // sink the whole search — the vector branch can still return useful
      // results. Caller would see no lexical hits.
      void err;
      return [];
    }
  }

  private resolveScope(request: SearchRequest, warnings: string[]): ResolvedScope {
    if (request.path === undefined) {
      return Object.freeze({ mode: "all", project: null, relPrefix: null, inputPath: null });
    }

    // Realpath here too: discovery.resolveProject walks via realpath
    // internally, and on macOS `/var/folders` → `/private/var/folders` so
    // the input path and project root would otherwise sit on opposite
    // sides of the symlink. Falls back to plain `resolve` when the path
    // doesn't exist on disk yet (so the "outside any project" warning
    // still fires sensibly for typo'd paths).
    const resolved = isAbsolute(request.path) ? request.path : resolve(request.path);
    let absPath: string;
    try {
      absPath = realpathSync(resolved);
    } catch {
      absPath = resolved;
    }
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

function buildVectorWhere(scope: ResolvedScope, language?: string): string | null {
  // LanceDB DataFusion supports SQL LIKE on Utf8 columns; pushing the
  // path-prefix into the predicate fixes the subtree-search overfetch
  // problem (ranked top-k limited globally then filtered host-side).
  const clauses = [
    scope.project !== null ? `project_id = ${quoteSql(scope.project.id)}` : null,
    scope.relPrefix !== null ? `rel_path LIKE ${quoteSql(`${scope.relPrefix}%`)}` : null,
    language ? `language = ${quoteSql(language)}` : null,
  ].filter((c): c is string => c !== null);
  return clauses.length === 0 ? null : clauses.join(" AND ");
}

function quoteSql(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Translate a natural-language query into an FTS5 expression. SQLite's
 * default is implicit AND between terms, which is way too strict for
 * agent-style queries like "rate limit middleware" where the user
 * doesn't expect every word to appear in the same chunk. We tokenize
 * (Unicode letters/numbers + underscore), drop tokens shorter than 2
 * characters, and OR them. BM25 IDF naturally suppresses common terms.
 */
function toFtsExpression(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  // Quote each token so FTS5 doesn't trip on tokens that happen to
  // collide with operators (NEAR, AND, OR, NOT) or special chars.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

interface FusedEntry {
  readonly chunkId: string;
  readonly score: number;
  readonly sources: ReadonlyArray<RetrievalSource>;
}

/**
 * Reciprocal rank fusion. Each branch contributes `1 / (k + rank)` to the
 * fused score for every chunk it ranks; chunks ranked by both branches
 * accumulate from both. Robust to scale differences across branches —
 * BM25 and cosine similarity are not directly comparable.
 */
function rrfFuse(
  vector: ReadonlyArray<VectorMatch>,
  lexical: ReadonlyArray<LexicalMatch>,
  k: number,
): FusedEntry[] {
  const aggregate = new Map<string, { score: number; sources: Set<RetrievalSource> }>();
  for (const [i, m] of vector.entries()) {
    const entry = aggregate.get(m.chunkId) ?? { score: 0, sources: new Set<RetrievalSource>() };
    entry.score += 1 / (k + i + 1);
    entry.sources.add("vector");
    aggregate.set(m.chunkId, entry);
  }
  for (const [i, m] of lexical.entries()) {
    const entry = aggregate.get(m.chunkId) ?? { score: 0, sources: new Set<RetrievalSource>() };
    entry.score += 1 / (k + i + 1);
    entry.sources.add("lexical");
    aggregate.set(m.chunkId, entry);
  }
  return [...aggregate.entries()]
    .map(([chunkId, e]) => ({
      chunkId,
      score: e.score,
      sources: Object.freeze([...e.sources].sort()),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Build a SearchResult from whichever branch(es) returned this chunk.
 * Vector matches carry richer metadata (language is stored, snippet is
 * the embedded document); lexical matches carry start/end_line + kind
 * via the JOIN to chunks. Either is enough on its own.
 */
function assembleResult(
  fused: FusedEntry,
  vector: VectorMatch | undefined,
  lexical: LexicalMatch | undefined,
  projectsById: ReadonlyMap<string, Project>,
): SearchResult {
  const projectId = lexical?.projectId ?? String(vector?.metadata["project_id"] ?? "");
  const relPath = lexical?.relPath ?? String(vector?.metadata["rel_path"] ?? "");
  const project = projectsById.get(projectId) ?? null;

  // Prefer vector metadata for language (stored at index time); fall back
  // to detecting from rel_path so lexical-only hits still report language.
  const language =
    (vector?.metadata["language"] as string | undefined) ??
    (relPath !== "" ? (detectLanguage(relPath) ?? "") : "");

  const startLine = lexical?.startLine ?? Number(vector?.metadata["start_line"] ?? 0);
  const endLine = lexical?.endLine ?? Number(vector?.metadata["end_line"] ?? 0);
  const kind = lexical?.kind ?? String(vector?.metadata["kind"] ?? "");
  const snippet = vector?.document ?? lexical?.document ?? "";

  const symbols = lexical?.symbols ?? parseSymbols(vector?.metadata["symbols"]);

  return Object.freeze({
    projectId,
    projectName: project?.name ?? "",
    projectRoot: project?.root ?? null,
    relPath,
    absPath: project !== null && relPath !== "" ? join(project.root, relPath) : null,
    startLine,
    endLine,
    score: fused.score,
    snippet,
    language,
    kind,
    symbols,
    sources: fused.sources,
  });
}

function parseSymbols(raw: unknown): ReadonlyArray<string> {
  if (typeof raw !== "string" || raw.length === 0) return Object.freeze([]);
  return Object.freeze(raw.split(",").filter((s) => s !== ""));
}
