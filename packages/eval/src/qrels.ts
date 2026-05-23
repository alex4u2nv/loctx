/**
 * JSONL qrels loader + span-overlap matcher.
 *
 * Schema is one JSON object per non-blank, non-comment line. Validated
 * with a hand-rolled strategy (matches the rest of loctx) — small enough
 * not to need zod, strict enough to catch authoring slips early.
 *
 * Span-overlap is the matcher (not exact docid equality) because chunk
 * boundaries can shift across re-chunks of the same content. See D2 in
 * the eval-harness plan.
 */

import { readFileSync } from "node:fs";
import type { Qrel, QueryType, RankedDoc, Relevance } from "./types.js";
import { queryId } from "./types.js";

export class QrelsLoadError extends Error {}

const VALID_QUERY_TYPES: ReadonlySet<QueryType> = new Set([
  "literal",
  "symbol",
  "concept",
  "mixed",
  "prose",
]);
const VALID_RELEVANCES: ReadonlySet<Relevance> = new Set<Relevance>([0, 1, 2]);

interface RawQrel {
  readonly query_id?: unknown;
  readonly query?: unknown;
  readonly query_type?: unknown;
  readonly rel_path?: unknown;
  readonly start_line?: unknown;
  readonly end_line?: unknown;
  readonly relevance?: unknown;
  readonly notes?: unknown;
  readonly provenance?: unknown;
}

/**
 * Parse a `qrels.jsonl` file. Throws `QrelsLoadError` with the offending
 * line number on the first invalid row so authors can fix the file
 * before re-running.
 */
export function loadQrels(path: string): ReadonlyArray<Qrel> {
  const text = readFileSync(path, "utf-8");
  return parseQrels(text, path);
}

export function parseQrels(text: string, source = "<inline>"): ReadonlyArray<Qrel> {
  const out: Qrel[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (err) {
      throw new QrelsLoadError(`${source}:${i + 1}: invalid JSON: ${(err as Error).message}`);
    }
    out.push(validateQrel(parsed, source, i + 1));
  }
  return Object.freeze(out);
}

function validateQrel(raw: unknown, source: string, lineNo: number): Qrel {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new QrelsLoadError(`${source}:${lineNo}: row must be a JSON object.`);
  }
  const r = raw as RawQrel;
  const id = requireString(r.query_id, "query_id", source, lineNo);
  const query = requireString(r.query, "query", source, lineNo);
  const qtRaw = requireString(r.query_type, "query_type", source, lineNo);
  if (!VALID_QUERY_TYPES.has(qtRaw as QueryType)) {
    throw new QrelsLoadError(
      `${source}:${lineNo}: query_type must be one of ${[...VALID_QUERY_TYPES].join(", ")} (got '${qtRaw}').`,
    );
  }
  const relPath = requireString(r.rel_path, "rel_path", source, lineNo);
  const startLine = requireInt(r.start_line, "start_line", source, lineNo);
  const endLine = requireInt(r.end_line, "end_line", source, lineNo);
  if (startLine < 1) {
    throw new QrelsLoadError(`${source}:${lineNo}: start_line must be >= 1.`);
  }
  if (endLine < startLine) {
    throw new QrelsLoadError(`${source}:${lineNo}: end_line must be >= start_line.`);
  }
  const relevance = requireInt(r.relevance, "relevance", source, lineNo);
  if (!VALID_RELEVANCES.has(relevance as Relevance)) {
    throw new QrelsLoadError(
      `${source}:${lineNo}: relevance must be one of 0, 1, 2 (got ${relevance}).`,
    );
  }
  const provenance = requireString(r.provenance, "provenance", source, lineNo);
  const notes = r.notes === undefined ? undefined : requireString(r.notes, "notes", source, lineNo);
  return Object.freeze<Qrel>({
    queryId: queryId(id),
    query,
    queryType: qtRaw as QueryType,
    relPath,
    startLine,
    endLine,
    relevance: relevance as Relevance,
    ...(notes !== undefined ? { notes } : {}),
    provenance,
  });
}

function requireString(v: unknown, field: string, source: string, lineNo: number): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new QrelsLoadError(`${source}:${lineNo}: field '${field}' must be a non-empty string.`);
  }
  return v;
}

function requireInt(v: unknown, field: string, source: string, lineNo: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new QrelsLoadError(`${source}:${lineNo}: field '${field}' must be an integer.`);
  }
  return v;
}

/**
 * Group qrels by queryId so the runner / scorer can iterate one query
 * at a time. Each group keeps insertion order from the source file so
 * authoring order surfaces in per-query reports.
 */
export function groupQrelsByQuery(
  qrels: ReadonlyArray<Qrel>,
): ReadonlyMap<string, ReadonlyArray<Qrel>> {
  const out = new Map<string, Qrel[]>();
  for (const q of qrels) {
    const bucket = out.get(q.queryId) ?? [];
    bucket.push(q);
    out.set(q.queryId, bucket);
  }
  // Freeze each bucket so callers can't mutate one mid-iteration.
  const frozen = new Map<string, ReadonlyArray<Qrel>>();
  for (const [k, v] of out) frozen.set(k, Object.freeze(v));
  return frozen;
}

/**
 * Span-overlap: two `[start, end]` ranges on the same file count as a
 * match if they share at least one line. Same-file enforcement lives
 * in the caller — this helper does the bound check only.
 */
export function spansOverlap(
  a: { readonly startLine: number; readonly endLine: number },
  b: { readonly startLine: number; readonly endLine: number },
): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * For one query, walk a ranked doc list and tag each ranked entry with
 * the highest relevance grade it overlaps in the per-query qrels. Docs
 * that overlap nothing get relevance 0. Used by every metric function
 * so they share the same matching rule.
 */
export function judgeRanked(
  ranked: ReadonlyArray<RankedDoc>,
  qrels: ReadonlyArray<Qrel>,
): ReadonlyArray<Relevance> {
  return ranked.map((doc) => {
    let best: Relevance = 0;
    for (const q of qrels) {
      if (q.relPath !== doc.relPath) continue;
      if (!spansOverlap(doc, q)) continue;
      if (q.relevance > best) best = q.relevance;
    }
    return best;
  });
}
