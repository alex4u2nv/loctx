/**
 * Semantic near-duplicate detection over existing chunk embeddings (#523).
 *
 * The exact-match duplicates analyzer (duplicates.ts) hashes token
 * windows and scopes out clone detection. Meanwhile every chunk already
 * has an embedding in the vector store, used only for retrieval. This
 * module turns those vectors into "these blocks do the same thing"
 * groups at QUERY time — no new inference, no writes at index time.
 *
 * Cost model: the caller reads a CAPPED set of chunk vectors from the
 * vector store (`semanticMaxChunks`) and this module does one bounded
 * pairwise pass over them. No per-chunk ANN queries (N round-trips into
 * the native layer cost more than one capped scan), and nothing here
 * runs during indexing — the O(n²) stays behind an explicit on-demand
 * call, mirroring how the exact duplicates split write-time windows
 * from query-time grouping. When the scan cap truncates coverage the
 * result says so (`truncated`) — no silent caps.
 *
 * Pure module: takes plain chunk records, returns plain groups. The
 * vector-store scan lives in storage/vectors.ts; the MCP handler wires
 * the two together.
 */

import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { dot, round4, toUnit } from "./vector-math.js";

/** One chunk's identity + vector, as read from the vector store scan. */
export interface SemanticChunk {
  readonly chunkId: string;
  readonly fileId: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  /** ArrayLike so Float32Array from the vector store passes zero-copy. */
  readonly vector: ArrayLike<number>;
}

export interface SemanticDuplicateMember {
  readonly fileId: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface SemanticDuplicateGroup {
  /** Mean cosine similarity across the group's above-threshold pairs. */
  readonly similarity: number;
  /**
   * Distinct files across the WHOLE group. `members` is a capped,
   * file-diverse sample, so `members.length` can be smaller.
   */
  readonly files: number;
  readonly members: ReadonlyArray<SemanticDuplicateMember>;
}

export interface SemanticDuplicatesResult {
  readonly groups: ReadonlyArray<SemanticDuplicateGroup>;
  /** Chunks that entered the pairwise pass. */
  readonly scanned: number;
  /** True when the input hit the scan cap — coverage is partial. */
  readonly truncated: boolean;
}

export interface SemanticDuplicatesOptions {
  /** Cosine similarity floor, 0..1. Pairs below it never group. */
  readonly threshold: number;
  /** True when the vector scan stopped at its row cap. */
  readonly truncated: boolean;
  readonly maxGroups?: number;
  readonly maxMembersPerGroup?: number;
  /** Minimum distinct files for a group (mirrors find_duplicates' min_members). */
  readonly minFiles?: number;
}

const DEFAULT_MAX_GROUPS = 50;
const DEFAULT_MAX_MEMBERS = 10;

/**
 * Group chunks whose embeddings sit above the similarity threshold.
 * Same-file pairs never form an edge (a file is trivially similar to
 * itself); a group must span at least two distinct files. Components
 * are built union-find style over the above-threshold pairs, so two
 * chunks can land in one group transitively via a third.
 */
export async function findSemanticDuplicateGroups(
  chunks: ReadonlyArray<SemanticChunk>,
  opts: SemanticDuplicatesOptions,
): Promise<SemanticDuplicatesResult> {
  const maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS;
  const maxMembers = opts.maxMembersPerGroup ?? DEFAULT_MAX_MEMBERS;
  const minFiles = Math.max(2, opts.minFiles ?? 2);
  // Clamp: Float32-rounded unit vectors of byte-identical embeddings can
  // dot to 1 - 1e-7, so a threshold of exactly 1.0 would silently reject
  // true duplicates.
  const threshold = Math.min(opts.threshold, 1 - 1e-6);
  // Pre-normalize into typed arrays once: the pairwise loop then runs on
  // dot products instead of full cosine per pair.
  const usable = chunks
    .map((c) => ({ chunk: c, unit: toUnit(c.vector) }))
    .filter((c): c is { chunk: SemanticChunk; unit: Float32Array } => c.unit !== null);

  const parent = usable.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    // Path compression keeps repeated finds cheap on long chains.
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur] as number;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };

  // Edge similarity accumulators keyed by component root, merged on union.
  const simSum = new Map<number, number>();
  const simCount = new Map<number, number>();

  for (let i = 0; i < usable.length; i += 1) {
    // The pairwise pass is O(n²·dim) and runs on the daemon's single
    // event loop — yield periodically so MCP/stdio/HTTP stay responsive.
    if ((i & 63) === 63) await yieldToEventLoop();
    const a = usable[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < usable.length; j += 1) {
      const b = usable[j];
      if (b === undefined || a.chunk.fileId === b.chunk.fileId) continue;
      const sim = dot(a.unit, b.unit);
      if (sim < threshold) continue;
      const ra = find(i);
      const rb = find(j);
      const root = ra === rb ? ra : unionRoots(parent, simSum, simCount, ra, rb);
      simSum.set(root, (simSum.get(root) ?? 0) + sim);
      simCount.set(root, (simCount.get(root) ?? 0) + 1);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < usable.length; i += 1) {
    const root = find(i);
    if (root === i && (simCount.get(root) ?? 0) === 0) continue; // singleton
    const list = byRoot.get(root) ?? [];
    list.push(i);
    byRoot.set(root, list);
  }

  const groups: SemanticDuplicateGroup[] = [];
  for (const [root, indices] of byRoot.entries()) {
    if (indices.length < 2) continue;
    const componentChunks = indices
      .map((i) => usable[i]?.chunk)
      .filter((c): c is SemanticChunk => c !== undefined);
    const files = new Set(componentChunks.map((c) => c.fileId));
    if (files.size < minFiles) continue;
    const count = simCount.get(root) ?? 0;
    const sum = simSum.get(root) ?? 0;
    groups.push({
      similarity: count === 0 ? 0 : round4(sum / count),
      files: files.size,
      members: Object.freeze(pickDiverseMembers(componentChunks, maxMembers)),
    });
  }

  groups.sort((a, b) => (b.files !== a.files ? b.files - a.files : b.similarity - a.similarity));
  return Object.freeze({
    groups: Object.freeze(groups.slice(0, maxGroups)),
    scanned: usable.length,
    truncated: opts.truncated,
  });
}

// ---- helpers -----------------------------------------------------------

/**
 * Sample up to `max` members so distinct files are represented before
 * any file contributes a second chunk — a capped sample should show the
 * spread the `files` count advertises, not the first N scan rows.
 * Output is sorted by (relPath, startLine) for stable responses.
 */
function pickDiverseMembers(
  chunks: ReadonlyArray<SemanticChunk>,
  max: number,
): SemanticDuplicateMember[] {
  const byFile = new Map<string, SemanticChunk[]>();
  for (const c of chunks) {
    const list = byFile.get(c.fileId) ?? [];
    list.push(c);
    byFile.set(c.fileId, list);
  }
  const picked: SemanticChunk[] = [];
  for (let round = 0; picked.length < max; round += 1) {
    let added = false;
    for (const list of byFile.values()) {
      const next = list[round];
      if (next === undefined) continue;
      picked.push(next);
      added = true;
      if (picked.length >= max) break;
    }
    if (!added) break;
  }
  return picked
    .map((c) => ({
      fileId: c.fileId,
      relPath: c.relPath,
      startLine: c.startLine,
      endLine: c.endLine,
    }))
    .sort((a, b) =>
      a.relPath !== b.relPath ? a.relPath.localeCompare(b.relPath) : a.startLine - b.startLine,
    );
}

/** Merge two components, folding the smaller root's accumulators into the winner. */
function unionRoots(
  parent: number[],
  simSum: Map<number, number>,
  simCount: Map<number, number>,
  ra: number,
  rb: number,
): number {
  parent[rb] = ra;
  simSum.set(ra, (simSum.get(ra) ?? 0) + (simSum.get(rb) ?? 0));
  simCount.set(ra, (simCount.get(ra) ?? 0) + (simCount.get(rb) ?? 0));
  simSum.delete(rb);
  simCount.delete(rb);
  return ra;
}
