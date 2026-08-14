/**
 * File cohesion scoring from chunk embeddings (#524).
 *
 * A file whose chunks are semantically scattered mixes concerns and is
 * a split candidate. The signal is computable from vectors the index
 * already stores: per file, the mean cosine similarity of each chunk's
 * embedding to the file's centroid. Low mean similarity = scattered.
 *
 * Query-time only, like the semantic near-duplicate pass — nothing is
 * persisted, nothing runs during indexing, and the input is the same
 * capped `scanChunks` read (O(chunks·dim), far cheaper than the
 * pairwise pass). Consumed by the quality report (#525) as
 * `quality/low-cohesion` findings.
 *
 * Flagging is RELATIVE to the population, not a fixed cutoff: prose
 * and code embed with different spreads, so the two are scored as
 * separate populations (split by file extension) and a uniformly
 * cohesive population flags nothing. Files with fewer than
 * `minChunks` chunks are skipped — one or two chunks always score
 * high and mean nothing.
 */

import type { RulePackFinding } from "./rule-pack.js";
import type { SemanticChunk } from "./semantic-duplicates.js";
import { dot, round4, toUnit } from "./vector-math.js";

export interface FileCohesionScore {
  readonly fileId: string;
  readonly relPath: string;
  /** Mean cosine of chunk vectors to the file centroid, 0..1-ish. */
  readonly cohesion: number;
  readonly chunks: number;
  /** Population the file was scored against. */
  readonly population: "code" | "prose";
}

export interface CohesionOptions {
  /** Files with fewer chunks than this are skipped. */
  readonly minChunks?: number;
}

export interface CohesionFlagOptions {
  /**
   * Flag the bottom fraction of each population (0.1 = bottom decile),
   * but only files scoring below `absoluteCeiling` — a uniformly
   * cohesive project must flag nothing.
   */
  readonly bottomFraction?: number;
  /** A file is only flaggable when its cohesion is below this. */
  readonly absoluteCeiling?: number;
}

const DEFAULT_MIN_CHUNKS = 3;
const DEFAULT_BOTTOM_FRACTION = 0.1;
const DEFAULT_ABSOLUTE_CEILING = 0.5;

const PROSE_EXTENSIONS = new Set(["md", "mdx", "markdown", "txt", "rst", "adoc"]);

/**
 * Score every file with at least `minChunks` chunks. Pure — group the
 * scanned chunks by file, build each file's centroid, average the
 * cosine of members to it.
 */
export function computeFileCohesion(
  chunks: ReadonlyArray<SemanticChunk>,
  opts: CohesionOptions = {},
): FileCohesionScore[] {
  const minChunks = opts.minChunks ?? DEFAULT_MIN_CHUNKS;
  const byFile = new Map<string, { relPath: string; vectors: Float32Array[] }>();
  for (const c of chunks) {
    const unit = toUnit(c.vector);
    if (unit === null) continue;
    const entry = byFile.get(c.fileId) ?? { relPath: c.relPath, vectors: [] };
    entry.vectors.push(unit);
    byFile.set(c.fileId, entry);
  }

  const scores: FileCohesionScore[] = [];
  for (const [fileId, { relPath, vectors }] of byFile.entries()) {
    if (vectors.length < minChunks) continue;
    const centroid = meanVector(vectors);
    const centroidUnit = toUnit(centroid);
    if (centroidUnit === null) continue;
    let sum = 0;
    for (const v of vectors) sum += dot(v, centroidUnit);
    scores.push({
      fileId,
      relPath,
      cohesion: round4(sum / vectors.length),
      chunks: vectors.length,
      population: isProsePath(relPath) ? "prose" : "code",
    });
  }
  return scores.sort((a, b) => a.cohesion - b.cohesion);
}

export interface CohesionFlag {
  readonly fileId: string;
  readonly relPath: string;
  readonly score: FileCohesionScore;
  readonly finding: RulePackFinding;
}

/**
 * Pick the split candidates: per population, the bottom fraction of
 * scores that also fall below the absolute ceiling. Prose findings
 * carry a softer message — sectioned docs legitimately scatter.
 */
export function cohesionFlags(
  scores: ReadonlyArray<FileCohesionScore>,
  opts: CohesionFlagOptions = {},
): CohesionFlag[] {
  const bottomFraction = opts.bottomFraction ?? DEFAULT_BOTTOM_FRACTION;
  const ceiling = opts.absoluteCeiling ?? DEFAULT_ABSOLUTE_CEILING;
  const out: CohesionFlag[] = [];
  for (const population of ["code", "prose"] as const) {
    const pop = scores
      .filter((s) => s.population === population)
      .sort((a, b) => a.cohesion - b.cohesion);
    const take = Math.floor(pop.length * bottomFraction);
    for (const score of pop.slice(0, take)) {
      if (score.cohesion >= ceiling) continue;
      out.push({
        fileId: score.fileId,
        relPath: score.relPath,
        score,
        finding: {
          ruleId: "quality/low-cohesion",
          severity: "info",
          message:
            population === "code"
              ? `chunks of this file are semantically scattered (cohesion ${score.cohesion} across ${score.chunks} chunks, bottom ${Math.round(bottomFraction * 100)}% of the project) — likely mixed concerns; consider splitting`
              : `sections of this document are semantically scattered (cohesion ${score.cohesion} across ${score.chunks} chunks) — may cover several topics`,
          category: "architecture",
          lineFrom: 1,
          lineTo: 1,
        },
      });
    }
  }
  return out;
}

// ---- helpers -----------------------------------------------------------

function isProsePath(relPath: string): boolean {
  const dotIdx = relPath.lastIndexOf(".");
  if (dotIdx < 0) return false;
  return PROSE_EXTENSIONS.has(relPath.slice(dotIdx + 1).toLowerCase());
}

function meanVector(vectors: ReadonlyArray<Float32Array>): Float32Array {
  const first = vectors[0];
  if (first === undefined) return new Float32Array(0);
  const out = new Float32Array(first.length);
  for (const v of vectors) {
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) + (v[i] as number);
  }
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) / vectors.length;
  return out;
}
