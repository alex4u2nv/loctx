/**
 * Agent-context markdown quality rules (#527).
 *
 * Half of what loctx indexes is markdown that agents read as context:
 * CLAUDE.md files, docs, audit inventories. These rot in two ways the
 * index can detect:
 *
 *   - `quality/stale-ref` — the doc references paths that no longer
 *     exist. Covers markdown links AND backticked path mentions
 *     (`packages/core/src/foo.ts`), each resolved against both the
 *     doc's directory and the project root. Existence is checked on
 *     DISK, not the index, so a path that exists but is excluded by
 *     filtering never false-positives.
 *   - `quality/doc-drift` — the doc's embedding has moved away from
 *     the code it references. Doc-chunk centroid vs the pooled centroid
 *     of the referenced files' chunks, both read from vectors the index
 *     already stores. Soft signal: severity info, "may have drifted".
 *
 * Only `stale-ref` runs at enrichment time. Drift is a CROSS-FILE
 *     signal: on an initial index a doc's task can run before its
 *     referenced files are indexed, and the degraded row never heals
 *     (same trap as `high-fan-in`, see quality.ts). The drift pieces
 *     here are pure and are evaluated at query time by the quality
 *     report (#525) against live vectors.
 *
 * Pure where it matters: extraction and both rules take injected
 * `exists` / vector data, so every path is testable without a
 * filesystem or vector store.
 */

import { dirname, relative, resolve } from "node:path";
import type { ProjectId } from "../models.js";
import { extractMarkdownLinks } from "./definitions.js";
import type { RulePackFinding } from "./rule-pack.js";
import { dot, round4, toUnit } from "./vector-math.js";

/** Reference cap per doc: bounds the vector reads doc-drift performs. */
const MAX_RESOLVED_REFS = 20;

export interface PathRef {
  /** The reference as written. */
  readonly raw: string;
  readonly line: number;
}

/**
 * Path-shaped references in a markdown document: relative link targets
 * plus backticked path mentions. External URLs and anchors never
 * qualify. Backtick candidates must look like a path (at least one
 * slash, no spaces, an extension on the final segment) so ordinary
 * inline code doesn't flood the list.
 */
export function extractPathRefs(content: string): PathRef[] {
  const out: PathRef[] = [];
  const seen = new Set<string>();
  const push = (raw: string, line: number): void => {
    const key = `${raw}@${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw, line });
  };

  for (const { target, line } of extractMarkdownLinks(content)) {
    if (isExternalOrAnchor(target)) continue;
    const path = target.split("#")[0];
    if (path !== undefined && path !== "") push(path, line);
  }

  const backtick = /`([^`\n]+)`/g;
  let lineStart = 0;
  let lineNo = 1;
  // Track line numbers incrementally instead of re-splitting per match.
  let m: RegExpExecArray | null = backtick.exec(content);
  while (m !== null) {
    while (true) {
      const nl = content.indexOf("\n", lineStart);
      if (nl === -1 || nl >= m.index) break;
      lineStart = nl + 1;
      lineNo += 1;
    }
    const candidate = m[1] ?? "";
    if (isPathLike(candidate)) push(candidate, lineNo);
    m = backtick.exec(content);
  }
  return out;
}

/** Conservative path-shape test for backticked mentions. */
function isPathLike(candidate: string): boolean {
  if (candidate.length > 200 || candidate.includes(" ") || !candidate.includes("/")) return false;
  if (isExternalOrAnchor(candidate)) return false;
  if (!/^[\w.@~/-]+$/.test(candidate)) return false;
  const last = candidate.split("/").at(-1) ?? "";
  // Final segment needs an extension: `a/b` is usually prose or an
  // identifier; `a/b.ts` is a file reference. Globs are not checkable.
  return /\.[A-Za-z0-9]+$/.test(last) && !candidate.includes("*");
}

function isExternalOrAnchor(target: string): boolean {
  return /^(https?:|mailto:|tel:|\/\/|#)/i.test(target);
}

export interface ResolvedRef {
  readonly ref: PathRef;
  /** First base (docDir, then projectRoot) under which the path exists; null when neither. */
  readonly absPath: string | null;
}

/**
 * Resolve each reference against the doc's directory, then the project
 * root (bare `packages/...` mentions are root-relative). Home-prefixed
 * (`~/...`) references are outside the project and skipped entirely.
 */
export function resolvePathRefs(
  refs: ReadonlyArray<PathRef>,
  docDir: string,
  projectRoot: string,
  exists: (absPath: string) => boolean,
): ResolvedRef[] {
  return refs
    .filter((ref) => !ref.raw.startsWith("~"))
    .map((ref) => {
      for (const base of [docDir, projectRoot]) {
        const abs = resolve(base, ref.raw);
        // Confine to the project: a reference resolving outside the
        // root (../../elsewhere) is not ours to judge.
        if (!abs.startsWith(projectRoot)) continue;
        if (exists(abs)) return { ref, absPath: abs };
      }
      return { ref, absPath: null };
    });
}

/** `quality/stale-ref` findings for every reference that resolved nowhere. */
export function staleRefFindings(resolved: ReadonlyArray<ResolvedRef>): RulePackFinding[] {
  return resolved
    .filter((r) => r.absPath === null)
    .map((r) => ({
      ruleId: "quality/stale-ref",
      severity: "warning" as const,
      message: `references '${r.ref.raw}', which does not exist — stale agent context misleads readers`,
      category: "context",
      lineFrom: r.ref.line,
      lineTo: r.ref.line,
    }));
}

/**
 * `quality/doc-drift`: cosine between the doc's chunk centroid and the
 * pooled centroid of its referenced files' chunks. Null (no finding)
 * when either side has no vectors or similarity clears the floor.
 */
export function docDriftFinding(
  docVectors: ReadonlyArray<Float32Array>,
  refVectors: ReadonlyArray<Float32Array>,
  floor: number,
): RulePackFinding | null {
  const docCentroid = centroidUnit(docVectors);
  const refCentroid = centroidUnit(refVectors);
  if (docCentroid === null || refCentroid === null) return null;
  const similarity = round4(dot(docCentroid, refCentroid));
  if (similarity >= floor) return null;
  return {
    ruleId: "quality/doc-drift",
    severity: "info",
    message:
      `may have drifted from the code it references ` +
      `(doc/code similarity ${similarity}, floor ${floor}) — worth a re-read`,
    category: "context",
    lineFrom: 1,
    lineTo: 1,
  };
}

/**
 * Enrichment-time markdown pass for one doc: stale refs only. Drift is
 * query-time (module header). Recomputed whenever the doc changes;
 * known lag: deleting a referenced file doesn't re-trigger the docs
 * that point at it until they next change (or a version-bump backfill).
 */
export function runMarkdownStaleRefs(
  content: string,
  absPath: string,
  projectRoot: string,
  exists: (candidate: string) => boolean,
): RulePackFinding[] {
  return staleRefFindings(
    resolvePathRefs(extractPathRefs(content), dirname(absPath), projectRoot, exists),
  );
}

/** Vector access for query-time doc-drift (#525). */
export interface MarkdownVectorPort {
  /** Chunk vectors of the indexed file at (project, relPath); empty when not indexed. */
  chunkVectorsForPath(projectId: ProjectId, relPath: string): Promise<ReadonlyArray<Float32Array>>;
}

/**
 * Query-time doc-drift for one doc (#525): resolve its live refs, pool
 * the referenced files' vectors, compare centroids. Null when nothing
 * resolves or similarity clears the floor.
 */
export async function runDocDrift(
  content: string,
  absPath: string,
  ctx: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly driftFloor: number;
    readonly exists: (candidate: string) => boolean;
    readonly vectors: MarkdownVectorPort;
  },
): Promise<RulePackFinding | null> {
  const resolved = resolvePathRefs(
    extractPathRefs(content),
    dirname(absPath),
    ctx.projectRoot,
    ctx.exists,
  );
  const live = resolved.filter((r) => r.absPath !== null).slice(0, MAX_RESOLVED_REFS);
  if (live.length === 0) return null;
  const docVectors = await ctx.vectors.chunkVectorsForPath(
    ctx.projectId,
    relative(ctx.projectRoot, absPath),
  );
  const refVectors: Float32Array[] = [];
  for (const r of live) {
    const vecs = await ctx.vectors.chunkVectorsForPath(
      ctx.projectId,
      relative(ctx.projectRoot, r.absPath as string),
    );
    refVectors.push(...vecs);
  }
  return docDriftFinding(docVectors, refVectors, ctx.driftFloor);
}

/** Is this path one the markdown rules apply to? */
export function isMarkdownPath(absPath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(absPath);
}

// ---- helpers -----------------------------------------------------------

function centroidUnit(vectors: ReadonlyArray<Float32Array>): Float32Array | null {
  const first = vectors[0];
  if (first === undefined) return null;
  const sum = new Float32Array(first.length);
  for (const v of vectors) {
    for (let i = 0; i < sum.length; i += 1) sum[i] = (sum[i] as number) + (v[i] as number);
  }
  return toUnit(sum);
}
