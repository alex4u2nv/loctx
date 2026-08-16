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
import type { AnalyzerMetadata, FileId, Project, ProjectId } from "../models.js";
import type { LexicalMatch, StateStore, VectorMatch, VectorStore } from "../storage/index.js";
import {
  emptyEnrichments,
  filterFindingsForRange,
  type LizardEnrichmentMetric,
  pickOverlapping,
  type RulePackFindingEnrichment,
  readLizardFunctions,
  readRulePackFindings,
  type SearchResultEnrichments,
} from "./enrichment-attach.js";
import {
  AUTHORITY_REASON_MIN,
  AUTHORITY_WEIGHT,
  assembleResult,
  BOOST_PER_REASON,
  buildVectorWhere,
  coverageKey,
  DEFINITION_BOOST,
  DERIVATIVE_PENALTY,
  findDeepestIndexedAncestor,
  isDefinitionMatch,
  isDerivativeSource,
  mergeBranchFields,
  rrfFuse,
  toFtsExpression,
  uniqueIds,
} from "./fusion.js";
import { analyzerQueryTerms, computeMatchReasons } from "./match-reasons.js";

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
  /**
   * Concept/refactor coverage mode (#72). After the normal hybrid
   * search resolves, expand each top hit by following analyzer-driven
   * cross-references: callers of the chunk's exported symbols, files
   * that import the same modules, and direct sibling files. Expanded
   * hits carry `coverageReason` explaining why they were pulled in,
   * and append after the original ranked list. Useful for "what else
   * touches X" queries before a refactor.
   */
  readonly coverage?: boolean;
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

/**
 * Why a result ranked where it did. Surfaced to agents so they can
 * explain their tool calls; also a debugging aid for retrieval quality.
 *
 *   - symbol_match        chunk defines/exports a symbol that appears in the query
 *   - import_match        chunk imports a module/path mentioned in the query
 *   - call_match          chunk calls an identifier mentioned in the query
 *   - risky_call_category chunk uses a risky API category (eval/exec/...) the query named
 *   - complexity_signal   query asks about complexity/depth/nesting and chunk scores high
 *   - async_match         query mentions async and chunk uses async
 *   - exported            chunk exports the matched symbol (slight rank bump on its own)
 *   - authoritative       the doc is referenced by many other docs (#427) — a
 *                         source-of-truth signal from the cross-link graph
 *   - definition          the chunk's heading/title matches the query concept,
 *                         i.e. it *defines* the thing rather than mentioning it
 *   - derivative          a down-weighted derivative format (presentation /
 *                         slide deck / catalog index), not a primary source
 */
export type MatchReason =
  | "symbol_match"
  | "import_match"
  | "call_match"
  | "risky_call_category"
  | "complexity_signal"
  | "async_match"
  | "exported"
  | "authoritative"
  | "definition"
  | "derivative";

export interface SearchResult {
  /**
   * Branded project id (CORE-10). Rows always carry a real ProjectId;
   * typing it as plain string forced `as ProjectId` re-casts at every
   * StateStore lookup downstream.
   */
  readonly projectId: ProjectId;
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
  /**
   * Cheap AST-derived metadata for this chunk — imports, calls,
   * complexity, risky-call categories, etc. Null when the chunk was
   * indexed before the v3 schema or is a non-code (markdown/prose)
   * chunk that the analyzer skips. Always present as a key so existing
   * agents that ignore it stay happy.
   */
  readonly analyzer: AnalyzerMetadata | null;
  /**
   * Why this chunk ranked here. Empty array when no analyzer-driven
   * reason fired (the rank is pure RRF over vector + lexical). Each
   * entry corresponds to a {@link MatchReason} category — see its docs
   * for what each signal means.
   */
  readonly matchReasons: ReadonlyArray<MatchReason>;
  /**
   * How many other indexed docs link to this file — the inbound-link count
   * from the cross-link graph (#427). An authority/source-of-truth signal:
   * the canonical doc is the one everything references. 0 for code/unlinked
   * files. Callers can re-rank on this even if they disagree with default order.
   */
  readonly referencedBy: number;
  /**
   * Coverage mode (#72) only. When the result was added by the
   * coverage expansion pass, this string explains why — e.g.
   * `caller-of:authenticateUser`, `imported-by:src/main.ts`,
   * `sibling-of:src/auth.ts`. Null on results from the original
   * ranked list. Always present as a key for stable agent payloads.
   */
  readonly coverageReason: string | null;
  /**
   * Background-analyzer findings attached to this result, when present
   * and overlapping the chunk's line range. Each analyzer's payload
   * shape is its own contract.
   */
  readonly enrichments: SearchResultEnrichments;
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
    // root. Served from the discovery layer's short-TTL cache (#443); only
    // the first search per TTL window pays the filesystem walk.
    const projectsById = new Map<string, Project>();
    for (const p of this.discovery.discoverProjects()) projectsById.set(p.id, p);

    // Pre-fetch analyzer metadata for the over-fetched candidate set so
    // we can apply analyzer-aware boosts BEFORE the slice(limit) cut.
    // Without that, a chunk that would have moved into the top-N because
    // of a symbol_match never gets the chance.
    const candidateIds = uniqueIds(matches, lexicalMatches);
    const analyzers = this.state.getAnalyzersByChunkIds(candidateIds);
    const queryTerms = analyzerQueryTerms(request.query);

    const vectorById = new Map(matches.map((m) => [m.chunkId, m]));
    const lexicalById = new Map(lexicalMatches.map((m) => [m.chunkId, m]));

    const fused = rrfFuse(matches, lexicalMatches, this.retrieval.rrfK);
    // Batch the inbound-link authority counts for the whole candidate set
    // in one GROUP BY query (#446) instead of a round-trip per unique
    // file inside the ranking loop below.
    const absByChunk = new Map<string, string>();
    for (const entry of fused) {
      const { relPath, projectId } = mergeBranchFields(
        vectorById.get(entry.chunkId),
        lexicalById.get(entry.chunkId),
      );
      const proj = projectsById.get(projectId);
      if (proj !== undefined && relPath !== "") {
        absByChunk.set(entry.chunkId, join(proj.root, relPath));
      }
    }
    const inboundByPath = this.state.inboundCounts([...absByChunk.values()]);
    // Apply boosts over the full candidate set BEFORE slicing so a buried-
    // but-authoritative doc can climb into the top-N (#427). Three signals
    // beyond the analyzer reasons: inbound-link authority, heading-defines-
    // concept, and a down-weight for derivative formats.
    for (const entry of fused) {
      const reasons = [...computeMatchReasons(analyzers.get(entry.chunkId) ?? null, queryTerms)];
      let boost = reasons.length * BOOST_PER_REASON;

      const { relPath, projectId, kind, symbols } = mergeBranchFields(
        vectorById.get(entry.chunkId),
        lexicalById.get(entry.chunkId),
      );

      // Authority: how many other docs link to this file (source-of-truth).
      const proj = projectsById.get(projectId);
      if (proj !== undefined && relPath !== "") {
        const abs = absByChunk.get(entry.chunkId) ?? join(proj.root, relPath);
        const refBy = inboundByPath.get(abs) ?? 0;
        entry.referencedBy = refBy;
        if (refBy > 0) {
          boost += AUTHORITY_WEIGHT * Math.log1p(refBy);
          if (refBy >= AUTHORITY_REASON_MIN) reasons.push("authoritative");
        }
      }
      // Definition vs mention: a heading/title that names the query concept.
      if (isDefinitionMatch(kind, symbols, queryTerms.tokens)) {
        boost += DEFINITION_BOOST;
        reasons.push("definition");
      }
      // Source-type prior: derivative formats (slides, catalog index) rank below
      // the process/spec docs they restate.
      if (isDerivativeSource(relPath)) {
        boost += DERIVATIVE_PENALTY;
        reasons.push("derivative");
      }

      entry.matchReasons = Object.freeze(reasons);
      entry.score += boost;
    }
    fused.sort((a, b) => b.score - a.score);
    const top = fused.slice(0, limit);

    const results: SearchResult[] = top.map((entry) => {
      const v = vectorById.get(entry.chunkId);
      const l = lexicalById.get(entry.chunkId);
      return assembleResult(entry, v, l, projectsById, analyzers.get(entry.chunkId) ?? null);
    });

    // Coverage expansion (#72). Skipped unless the caller asked.
    // Capped at 2x the requested limit so payloads stay bounded.
    const expandedResults = request.coverage
      ? this.expandCoverage(results, projectsById, limit * 2)
      : results;

    // Background-analyzer surfacing (#62 #65). Walk every result, fetch
    // the file's enrichment payloads, attach the slice that overlaps
    // this chunk's line range. Skipped silently when nothing's
    // persisted — analyzers are opt-in.
    const finalResults = this.attachEnrichments(expandedResults);

    return Object.freeze({
      resolvedScope: scope,
      results: Object.freeze(finalResults),
      warnings: Object.freeze(warnings),
    });
  }

  /**
   * Concept/refactor coverage expansion (#72). Walks each top-K hit's
   * exported symbols, looks up call sites via the symbol_refs graph
   * from #96, and adds the surrounding chunks as expanded results
   * tagged with `coverageReason`. Existing chunks are deduped. Cap
   * keeps the response payload small.
   */
  /**
   * Walk results, look up persisted analyzer payloads from
   * `file_enrichments`, attach the slice that overlaps each chunk's
   * line range. Per-(project,relPath) lookups are cached across the
   * batch so a top-K with multiple chunks from the same file pays
   * one StateStore read per analyzer.
   */
  private attachEnrichments(results: ReadonlyArray<SearchResult>): SearchResult[] {
    if (results.length === 0) return [...results];
    // One getFile per unique file (#446): the lizard + rule-pack readers
    // used to each resolve the file row independently, doubling the
    // lookup. Resolve the fileId once here and hand it to both.
    const fileIdCache = new Map<string, FileId | null>();
    const lizardCache = new Map<string, LizardEnrichmentMetric[] | null>();
    const findingsCache = new Map<string, RulePackFindingEnrichment[] | null>();

    return results.map((r) => {
      if (r.projectRoot === null) return r;
      const cacheKey = `${r.projectId}:${r.relPath}`;
      let fileId = fileIdCache.get(cacheKey);
      if (fileId === undefined) {
        fileId = this.state.getFile(r.projectId, r.relPath)?.fileId ?? null;
        fileIdCache.set(cacheKey, fileId);
      }
      if (fileId === null) return r;

      let lizardFns = lizardCache.get(cacheKey);
      if (lizardFns === undefined) {
        lizardFns = readLizardFunctions(this.state, fileId);
        lizardCache.set(cacheKey, lizardFns);
      }
      const lizard = lizardFns === null ? null : pickOverlapping(lizardFns, r.startLine, r.endLine);

      let allFindings = findingsCache.get(cacheKey);
      if (allFindings === undefined) {
        allFindings = readRulePackFindings(this.state, fileId);
        findingsCache.set(cacheKey, allFindings);
      }
      const findings =
        allFindings === null
          ? Object.freeze<RulePackFindingEnrichment[]>([])
          : Object.freeze(filterFindingsForRange(allFindings, r.startLine, r.endLine));

      if (lizard === null && findings.length === 0) return r;
      return Object.freeze({ ...r, enrichments: Object.freeze({ lizard, findings }) });
    });
  }

  // Synchronous on purpose: everything here is StateStore reads. The
  // stray `async` (audit 2026-08-06, lower-severity core notes) implied
  // I/O that never happened.
  private expandCoverage(
    originals: ReadonlyArray<SearchResult>,
    projectsById: ReadonlyMap<string, Project>,
    cap: number,
  ): SearchResult[] {
    const seen = new Set<string>(originals.map((r) => coverageKey(r)));
    const expanded: SearchResult[] = [];

    for (const orig of originals) {
      if (originals.length + expanded.length >= cap) break;
      const exports = orig.analyzer?.exports ?? orig.symbols;
      if (exports.length === 0) continue;
      for (const symbol of exports) {
        if (originals.length + expanded.length >= cap) break;
        const { defs, refs } = this.state.findSymbol(orig.projectId, symbol);
        // Skip the symbol's own def chunk; we only want callers/importers.
        for (const ref of [...defs, ...refs]) {
          if (originals.length + expanded.length >= cap) break;
          const key = `${ref.projectId}:${ref.relPath}:${ref.chunkStartLine}`;
          if (seen.has(key)) continue;
          const reason =
            ref.kind === "call"
              ? `caller-of:${symbol}`
              : ref.kind === "import"
                ? `imported-by:${ref.relPath}`
                : `references:${symbol}`;
          // Skip self (def) entries that came back via findSymbol — they
          // describe the same chunk that produced this `orig`.
          if (orig.relPath === ref.relPath && orig.startLine === ref.chunkStartLine) continue;
          const project = projectsById.get(ref.projectId);
          expanded.push(
            Object.freeze<SearchResult>({
              projectId: ref.projectId,
              projectName: project?.name ?? "",
              projectRoot: project?.root ?? null,
              relPath: ref.relPath,
              absPath: project !== undefined ? join(project.root, ref.relPath) : null,
              startLine: ref.chunkStartLine,
              endLine: ref.chunkEndLine,
              score: 0,
              snippet: "",
              language: "",
              kind: "",
              symbols: Object.freeze<string[]>([]),
              sources: Object.freeze<RetrievalSource[]>([]),
              analyzer: null,
              matchReasons: Object.freeze<MatchReason[]>([]),
              referencedBy: 0,
              coverageReason: reason,
              enrichments: emptyEnrichments(),
            }),
          );
          seen.add(key);
        }
      }
    }

    return [...originals, ...expanded];
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
    return resolveProjectScope(this.discovery, this.state, request.path, warnings);
  }
}

/**
 * Resolve an optional `path` into a project/subtree scope, preferring the
 * deepest *indexed* ancestor over an unindexed inner marker (#276).
 *
 * Shared by `search_workspace`, `find_usages`, and `find_literal` so all
 * three handle nested packages identically: a path inside an unindexed
 * inner project (e.g. a monorepo `packages/core` with its own
 * `package.json`) scopes to the indexed parent that actually has data,
 * with a warning, instead of silently resolving to an empty inner project
 * and returning zero hits.
 *
 * `warnings` is appended to in place. Returns `mode: "all"` with a null
 * project when the path lands outside every indexed project; callers
 * decide whether that means "search everything" or "reject".
 */
export function resolveProjectScope(
  discovery: Pick<WorkspaceDiscovery, "resolveProject">,
  state: Pick<StateStore, "listProjects">,
  path: string | undefined,
  warnings: string[],
): ResolvedScope {
  if (path === undefined) {
    return Object.freeze({ mode: "all", project: null, relPrefix: null, inputPath: null });
  }

  // Realpath here too: discovery.resolveProject walks via realpath
  // internally, and on macOS `/var/folders` → `/private/var/folders` so
  // the input path and project root would otherwise sit on opposite
  // sides of the symlink. Falls back to plain `resolve` when the path
  // doesn't exist on disk yet (so the "outside any project" warning
  // still fires sensibly for typo'd paths).
  const resolved = isAbsolute(path) ? path : resolve(path);
  let absPath: string;
  try {
    absPath = realpathSync(resolved);
  } catch {
    absPath = resolved;
  }

  const markerProject = discovery.resolveProject(absPath);
  const indexedAncestor = findDeepestIndexedAncestor(state, absPath);

  let project: Project | null = null;
  if (markerProject !== null && indexedAncestor !== null) {
    // Both available. Prefer the inner marker only if it is itself an
    // indexed project; otherwise fall back to the deepest indexed
    // ancestor (#276) so the search has real data to draw on instead
    // of silently returning zero hits.
    if (markerProject.id === indexedAncestor.id) {
      project = markerProject;
    } else if (markerProject.root.startsWith(indexedAncestor.root + sep)) {
      project = indexedAncestor;
      warnings.push(
        `path ${absPath} is inside unindexed inner project ${markerProject.name} ` +
          `(${markerProject.root}); scoping to indexed parent ${indexedAncestor.name}.`,
      );
    } else {
      // Inner marker is not under the indexed ancestor (shouldn't
      // normally happen; defensive). Prefer the indexed project.
      project = indexedAncestor;
    }
  } else if (indexedAncestor !== null) {
    project = indexedAncestor;
  } else if (markerProject !== null) {
    // We have a marker but no indexed project covers this path. Keep
    // the marker so an "outside indexed scope" search still runs
    // against an empty subtree — caller sees zero results plus the
    // existing "not inside any indexed project" pathway.
    project = markerProject;
  }

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

// Walk through state-recorded active projects, return the deepest one whose
// root contains absPath (#276). Indexed-status is approximated by active=1;
// the heal pass in apps/cli ensures active projects with file rows surface
// here even when last_indexed_at started null.

// Re-exports (#542 split): existing importers keep working through
// searcher.ts.
export * from "./enrichment-attach.js";
