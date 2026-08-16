/**
 * Branch fusion + result assembly (#542 split from searcher.ts):
 * RRF fusion of vector/lexical branches, authority/definition
 * boosts, FTS expression building, and SearchResult assembly.
 */

import { join, sep } from "node:path";
import { detectLanguage } from "../chunking/index.js";
import type { AnalyzerMetadata, Project, ProjectId } from "../models.js";
import { projectId as toProjectId } from "../models.js";
import {
  type LexicalMatch,
  quoteSql,
  type StateStore,
  type VectorMatch,
} from "../storage/index.js";
import { emptyEnrichments } from "./enrichment-attach.js";
import type { MatchReason, ResolvedScope, RetrievalSource, SearchResult } from "./searcher.js";

export function findDeepestIndexedAncestor(
  state: Pick<StateStore, "listProjects">,
  absPath: string,
): Project | null {
  let best: Project | null = null;
  for (const row of state.listProjects()) {
    if (!row.active) continue;
    const root = row.root;
    if (absPath !== root && !absPath.startsWith(root + sep)) continue;
    if (best === null || root.length > best.root.length) {
      best = { id: row.id, name: row.name, root };
    }
  }
  return best;
}

// ---- helpers -----------------------------------------------------------

export function buildVectorWhere(scope: ResolvedScope, language?: string): string | null {
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

/**
 * Coalesce the two retrieval branches' views of a chunk into the fields
 * both can carry. Lexical matches (SQLite JOIN to chunks) win when
 * present; vector matches fall back to their stored metadata columns.
 * Previously inlined three times in this file (CORE-5).
 */
export function mergeBranchFields(
  v: VectorMatch | undefined,
  l: LexicalMatch | undefined,
): {
  readonly projectId: ProjectId;
  readonly relPath: string;
  readonly kind: string;
  readonly symbols: ReadonlyArray<string>;
} {
  return {
    // Vector metadata is unbranded at rest; this is the single
    // row→brand conversion point for search results (CORE-10).
    projectId: l?.projectId ?? toProjectId(String(v?.metadata["project_id"] ?? "")),
    relPath: l?.relPath ?? String(v?.metadata["rel_path"] ?? ""),
    kind: l?.kind ?? String(v?.metadata["kind"] ?? ""),
    symbols: l?.symbols ?? parseSymbols(v?.metadata["symbols"]),
  };
}

/**
 * Translate a natural-language query into an FTS5 expression. SQLite's
 * default is implicit AND between terms, which is way too strict for
 * agent-style queries like "rate limit middleware" where the user
 * doesn't expect every word to appear in the same chunk. We tokenize
 * (Unicode letters/numbers + underscore), drop tokens shorter than 2
 * characters, and OR them. BM25 IDF naturally suppresses common terms.
 */
export function toFtsExpression(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  // Quote each token so FTS5 doesn't trip on tokens that happen to
  // collide with operators (NEAR, AND, OR, NOT) or special chars.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export interface FusedEntry {
  readonly chunkId: string;
  score: number;
  readonly sources: ReadonlyArray<RetrievalSource>;
  matchReasons: ReadonlyArray<MatchReason>;
  /** Inbound-link count from the cross-link graph (#427). */
  referencedBy: number;
}

/**
 * Per-reason RRF score bump. Calibrated against the base contribution
 * `1 / (rrfK + rank)` ≈ 0.016 at rank 1 with k=60: a single matched
 * reason adds ~25% of the top-rank slot, two reasons add ~50%, enough
 * to nudge a strongly-matching analyzer hit past a marginal pure-text
 * one without overpowering RRF on its own. Heuristic; revisit when
 * #97's expanded eval set provides numbers to tune against.
 */
export const BOOST_PER_REASON = 0.004;

/**
 * Authority ranking weights (#427), calibrated against the RRF base
 * (`1/(k+rank)` ≈ 0.016 at rank 1) + BOOST_PER_REASON (0.004). Heuristic;
 * revisit against the eval set.
 *   - AUTHORITY_WEIGHT × log1p(inbound): ~0.024 at 10 inbound links — enough
 *     to lift a heavily-referenced canonical doc several rank slots.
 *   - DEFINITION_BOOST: a heading that names the concept (defines vs mentions).
 *   - DERIVATIVE_PENALTY: negative — slides/catalog rank below primary sources.
 */
export const AUTHORITY_WEIGHT = 0.01;
export const AUTHORITY_REASON_MIN = 2;
export const DEFINITION_BOOST = 0.006;
export const DERIVATIVE_PENALTY = -0.008;

/** Heading/title that names the query concept → the chunk *defines* it. */
export function isDefinitionMatch(
  kind: string,
  symbols: ReadonlyArray<string>,
  queryTokens: ReadonlySet<string>,
): boolean {
  if (!kind.startsWith("section") || symbols.length === 0) return false;
  for (const sym of symbols) {
    const heading = sym.toLowerCase();
    for (const tok of queryTokens) {
      if (tok.length >= 3 && heading.includes(tok)) return true;
    }
  }
  return false;
}

/** Derivative formats (presentations, slide decks, catalog index files). */
export function isDerivativeSource(relPath: string): boolean {
  return /(^|\/)(presentations?|slides?|decks?)\/|\.(slides?|deck)\.md$|(^|\/)index\.md$/i.test(
    relPath,
  );
}

/**
 * Reciprocal rank fusion. Each branch contributes `1 / (k + rank)` to the
 * fused score for every chunk it ranks; chunks ranked by both branches
 * accumulate from both. Robust to scale differences across branches —
 * BM25 and cosine similarity are not directly comparable.
 */
export function rrfFuse(
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
      matchReasons: Object.freeze<MatchReason[]>([]),
      referencedBy: 0,
    }))
    .sort((a, b) => b.score - a.score);
}

export function uniqueIds(
  vector: ReadonlyArray<VectorMatch>,
  lexical: ReadonlyArray<LexicalMatch>,
): string[] {
  const set = new Set<string>();
  for (const m of vector) set.add(m.chunkId);
  for (const m of lexical) set.add(m.chunkId);
  return [...set];
}

/**
 * Build a SearchResult from whichever branch(es) returned this chunk.
 * Vector matches carry richer metadata (language is stored, snippet is
 * the embedded document); lexical matches carry start/end_line + kind
 * via the JOIN to chunks. Either is enough on its own.
 */
export function assembleResult(
  fused: FusedEntry,
  vector: VectorMatch | undefined,
  lexical: LexicalMatch | undefined,
  projectsById: ReadonlyMap<string, Project>,
  analyzer: AnalyzerMetadata | null,
): SearchResult {
  const { projectId, relPath, kind, symbols } = mergeBranchFields(vector, lexical);
  const project = projectsById.get(projectId) ?? null;

  // Prefer vector metadata for language (stored at index time); fall back
  // to detecting from rel_path so lexical-only hits still report language.
  const language =
    (vector?.metadata["language"] as string | undefined) ??
    (relPath !== "" ? (detectLanguage(relPath) ?? "") : "");

  const startLine = lexical?.startLine ?? Number(vector?.metadata["start_line"] ?? 0);
  const endLine = lexical?.endLine ?? Number(vector?.metadata["end_line"] ?? 0);
  const snippet = vector?.document ?? lexical?.document ?? "";

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
    analyzer,
    matchReasons: fused.matchReasons,
    referencedBy: fused.referencedBy,
    coverageReason: null,
    // Enrichments populated in a second pass after assembleResult
    // returns; this keeps the per-result builder pure and lets the
    // searcher batch the StateStore reads.
    enrichments: emptyEnrichments(),
  });
}

export function parseSymbols(raw: unknown): ReadonlyArray<string> {
  if (typeof raw !== "string" || raw.length === 0) return Object.freeze([]);
  return Object.freeze(raw.split(",").filter((s) => s !== ""));
}

/** Stable identity for coverage-dedupe: project + file + chunk-start. */
export function coverageKey(r: SearchResult): string {
  return `${r.projectId}:${r.relPath}:${r.startLine}`;
}

/**
 * Pull lizard's per-function metrics for a file out of file_enrichments.
 * Returns null when no enrichment exists or the payload is unparseable;
 * empty array means lizard ran but found no functions.
 */
