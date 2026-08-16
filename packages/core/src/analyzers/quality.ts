/**
 * Heuristic code-quality analyzer (#522).
 *
 * Pure TypeScript, no external binary — combines signals the index
 * already holds: per-chunk AST metadata (tree-sitter, #59), lizard's
 * per-function complexity when that analyzer has run, and the
 * symbol-reference graph (#96). Emits the shared rule-pack finding
 * shape so search-time attachment, severity ordering, and backfill
 * come free.
 *
 * Data access goes through the narrow {@link QualityIndexReader} port;
 * the container adapts StateStore onto it. That keeps this module free
 * of storage imports (and of `container.ts` — see the module-boundaries
 * test) and makes every rule testable with plain objects.
 *
 * Two rules are deliberately NOT computed per file at enrichment time,
 * because their inputs are cross-file and an enrichment row is keyed to
 * one file's content sha (it would go stale the moment *other* files
 * change, and undercount during an initial index):
 *   - `quality/extract-candidate` — matching one file's duplicate
 *     windows against every other file's stored windows would re-create
 *     exactly the O(files²) indexing-time cost the duplicates analyzer
 *     split out into query-time aggregation (see duplicates.ts). It
 *     derives from the query-time duplicate groups instead
 *     ({@link extractCandidates}).
 *   - `quality/high-fan-in` — inbound references accrue as OTHER files
 *     index, so a per-file snapshot taken at this file's index time is
 *     wrong on arrival. {@link fanInFinding} is the pure rule; the
 *     quality report (#525) evaluates it against a live count.
 *
 * Rules degrade gracefully: chunks without AST metadata (prose, files
 * indexed before v3) skip the metadata rules; when lizard hasn't run
 * (or produced no functions for this file), `long-params` falls back to
 * chunk metadata and `deep-nesting` skips its CCN escalation. The
 * container re-enqueues quality once lizard's result lands, so the
 * degraded pass upgrades instead of being cached until the next edit.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AnalyzerMetadata, FileId } from "../models.js";
import type { LizardFileResult } from "./lizard.js";
import { isMarkdownPath, runMarkdownStaleRefs } from "./quality-markdown.js";
import { capFindings, type RulePackFileResult, type RulePackFinding } from "./rule-pack.js";

export const QUALITY_VERSION = 2; // v2: markdown context rules (#527)

/** One chunk of the analyzed file: line range + optional AST metadata. */
export interface QualityChunkInfo {
  readonly startLine: number;
  readonly endLine: number;
  readonly metadata: AnalyzerMetadata | null;
}

/**
 * Read-only index access the analyzer needs, defined here so the
 * dependency points inward (the container adapts StateStore onto this
 * port, not the other way around). All methods are consulted at task
 * run time — after the indexer's write for the file has committed.
 */
export interface QualityIndexReader {
  /** Chunk ranges + AST metadata for the file, in file order. */
  chunksForFile(fileId: FileId): ReadonlyArray<QualityChunkInfo>;
  /**
   * Parsed lizard enrichment for the file; null when absent, incomplete,
   * or computed from different content than `contentSha` (a stale row
   * from the file's previous version must not shape current findings).
   */
  lizardForFile(fileId: FileId, contentSha: string): LizardFileResult | null;
}

export interface QualityThresholds {
  /** `god-file` fires when non-empty lines AND distinct exports both exceed. */
  readonly godFileNloc: number;
  readonly godFileExports: number;
  /** `long-params`: parameter count above this flags the function. */
  readonly maxParams: number;
  /** `deep-nesting`: chunk nesting depth at or above this flags the chunk. */
  readonly maxNestingDepth: number;
  /** `deep-nesting` escalates info → warning when the overlapping lizard CCN exceeds this. */
  readonly escalateCcn: number;
  /** `high-fan-out`: distinct imported modules above this flags the file. */
  readonly maxFanOut: number;
  /**
   * `high-fan-in`: distinct referencing files above this flags the file.
   * Evaluated at query time by the quality report (#525), not during
   * enrichment — see the module header.
   */
  readonly maxFanIn: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = Object.freeze({
  godFileNloc: 400,
  godFileExports: 10,
  maxParams: 5,
  maxNestingDepth: 4,
  escalateCcn: 10,
  maxFanOut: 20,
  maxFanIn: 25,
});

/** Everything the pure rule pass consumes. Assembled by {@link runQuality}. */
export interface QualityInput {
  readonly content: string;
  readonly chunks: ReadonlyArray<QualityChunkInfo>;
  readonly lizard: LizardFileResult | null;
}

export interface QualityOptions {
  readonly thresholds: QualityThresholds;
  /** Cap on findings persisted per file, matching the other rule packs. */
  readonly maxFindingsPerFile: number;
  /** Present ⇒ `quality/stale-ref` (#527) runs for markdown files. */
  readonly markdown?: QualityMarkdownOptions;
}

export interface QualityMarkdownOptions {
  readonly projectRoot: string;
}

/**
 * Run every rule over one file's signals. Pure — no I/O, no clock.
 * File-level findings (god-file, fan-in/out) anchor at line 1 so they
 * surface on the file's first chunk instead of repeating on every chunk.
 */
export function computeQualityFindings(
  input: QualityInput,
  opts: QualityOptions,
): RulePackFileResult {
  const t = opts.thresholds;
  const findings: RulePackFinding[] = [
    ...godFileFindings(input, t),
    ...fanOutFindings(input.chunks, t),
    ...longParamsFindings(input, t),
    ...deepNestingFindings(input, t),
  ];
  return Object.freeze({
    analyzer: "quality",
    toolVersion: String(QUALITY_VERSION),
    findings: capFindings(findings, opts.maxFindingsPerFile),
  });
}

/**
 * Assemble the input from disk + the reader port and run the rules.
 * Wired as the enrichment task body by the container's ANALYZERS row.
 */
export async function runQuality(
  absPath: string,
  fileId: FileId,
  contentSha: string,
  index: QualityIndexReader,
  opts: QualityOptions,
): Promise<RulePackFileResult> {
  const content = await readFile(absPath, "utf-8");
  const base = computeQualityFindings(
    {
      content,
      chunks: index.chunksForFile(fileId),
      lizard: index.lizardForFile(fileId, contentSha),
    },
    opts,
  );
  const md = opts.markdown;
  if (md === undefined || !isMarkdownPath(absPath)) return base;
  const mdFindings = runMarkdownStaleRefs(content, absPath, md.projectRoot, existsSync);
  if (mdFindings.length === 0) return base;
  return Object.freeze({
    ...base,
    findings: capFindings([...base.findings, ...mdFindings], opts.maxFindingsPerFile),
  });
}

// ---- rules -------------------------------------------------------------

const FILE_LEVEL_ANCHOR = { lineFrom: 1, lineTo: 1 } as const;

function godFileFindings(input: QualityInput, t: QualityThresholds): RulePackFinding[] {
  const lines = nonEmptyLineCount(input.content);
  const exports = distinctAcrossChunks(input.chunks, (m) => m.exports);
  if (lines <= t.godFileNloc || exports.size <= t.godFileExports) return [];
  return [
    {
      ruleId: "quality/god-file",
      severity: "warning",
      message:
        `file has ${lines} non-empty lines and ${exports.size} exports ` +
        `(thresholds ${t.godFileNloc}/${t.godFileExports}) — consider splitting by concern`,
      category: "architecture",
      ...FILE_LEVEL_ANCHOR,
    },
  ];
}

function fanOutFindings(
  chunks: ReadonlyArray<QualityChunkInfo>,
  t: QualityThresholds,
): RulePackFinding[] {
  const imports = distinctAcrossChunks(chunks, (m) => m.imports);
  if (imports.size <= t.maxFanOut) return [];
  return [
    {
      ruleId: "quality/high-fan-out",
      severity: "info",
      message:
        `file imports from ${imports.size} distinct modules (threshold ${t.maxFanOut}) — ` +
        `wide dependencies often mean mixed concerns`,
      category: "architecture",
      ...FILE_LEVEL_ANCHOR,
    },
  ];
}

/**
 * `quality/high-fan-in` as a pure rule over a LIVE inbound count.
 * Called by the quality report (#525) at query time — never from the
 * enrichment pass, where the count would be a stale per-file snapshot
 * (see the module header). Null when the count is under the threshold.
 */
export function fanInFinding(fanIn: number, t: QualityThresholds): RulePackFinding | null {
  if (fanIn <= t.maxFanIn) return null;
  return {
    ruleId: "quality/high-fan-in",
    severity: "info",
    message:
      `${fanIn} files reference symbols defined here (threshold ${t.maxFanIn}) — ` +
      `changes to this file carry wide blast radius`,
    category: "architecture",
    ...FILE_LEVEL_ANCHOR,
  };
}

/**
 * Prefer lizard's per-function parameter counts (precise ranges, real
 * parameter lists); fall back to the chunker's `paramCount` when lizard
 * hasn't run on this file — or ran but recognised no functions (a
 * complete-but-empty result must not suppress the fallback).
 */
function longParamsFindings(input: QualityInput, t: QualityThresholds): RulePackFinding[] {
  if (input.lizard !== null && input.lizard.functions.length > 0) {
    return input.lizard.functions
      .filter((f) => f.parameters > t.maxParams)
      .map((f) => ({
        ruleId: "quality/long-params",
        severity: "info" as const,
        message: `function '${f.name}' takes ${f.parameters} parameters (threshold ${t.maxParams})`,
        category: "complexity",
        lineFrom: f.lineFrom,
        lineTo: f.lineTo,
      }));
  }
  return input.chunks.flatMap((c) =>
    c.metadata !== null && c.metadata.paramCount > t.maxParams
      ? [
          {
            ruleId: "quality/long-params",
            severity: "info" as const,
            message: `function takes ${c.metadata.paramCount} parameters (threshold ${t.maxParams})`,
            category: "complexity",
            lineFrom: c.startLine,
            lineTo: c.endLine,
          },
        ]
      : [],
  );
}

function deepNestingFindings(input: QualityInput, t: QualityThresholds): RulePackFinding[] {
  const out: RulePackFinding[] = [];
  for (const c of input.chunks) {
    if (c.metadata === null || c.metadata.maxNestingDepth < t.maxNestingDepth) continue;
    const ccn = maxOverlappingCcn(input.lizard, c.startLine, c.endLine);
    const escalated = ccn !== null && ccn > t.escalateCcn;
    out.push({
      ruleId: "quality/deep-nesting",
      severity: escalated ? "warning" : "info",
      message:
        `nesting depth ${c.metadata.maxNestingDepth} (threshold ${t.maxNestingDepth})` +
        (escalated ? ` with cyclomatic complexity ${ccn} (threshold ${t.escalateCcn})` : ""),
      category: "complexity",
      lineFrom: c.startLine,
      lineTo: c.endLine,
    });
  }
  return out;
}

// ---- extract-candidate (query-time, consumed by the quality report) ----

/**
 * Structural mirror of StateStore's DuplicateGroup — declared here so
 * this module doesn't import storage types (dependency stays inward).
 */
export interface DuplicateGroupLike {
  readonly hash: string;
  readonly members: ReadonlyArray<{
    readonly fileId: string;
    readonly startLine: number;
    readonly endLine: number;
  }>;
}

export interface ExtractCandidate {
  readonly fileId: string;
  /** Distinct files sharing the window, including this one. */
  readonly memberFiles: number;
  readonly finding: RulePackFinding;
}

/**
 * Derive `quality/extract-candidate` findings from query-time duplicate
 * groups. A window shared by `minDistinctFiles` (default 3 — the repo's
 * "extract before the third caller" rule) flags every member. One
 * finding per (file, group); a file appearing in several groups gets
 * one finding per group.
 */
export function extractCandidates(
  groups: ReadonlyArray<DuplicateGroupLike>,
  minDistinctFiles = 3,
): ExtractCandidate[] {
  const out: ExtractCandidate[] = [];
  for (const group of groups) {
    const distinctFiles = new Set(group.members.map((m) => m.fileId));
    if (distinctFiles.size < minDistinctFiles) continue;
    for (const member of group.members) {
      out.push({
        fileId: member.fileId,
        memberFiles: distinctFiles.size,
        finding: {
          ruleId: "quality/extract-candidate",
          severity: "warning",
          message:
            `this block is duplicated across ${distinctFiles.size} files — ` +
            `extract the shared piece (house rule: extract before the third caller)`,
          category: "architecture",
          lineFrom: member.startLine,
          lineTo: member.endLine,
        },
      });
    }
  }
  return out;
}

// ---- helpers -----------------------------------------------------------

function nonEmptyLineCount(content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

function distinctAcrossChunks(
  chunks: ReadonlyArray<QualityChunkInfo>,
  select: (m: AnalyzerMetadata) => ReadonlyArray<string>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of chunks) {
    if (c.metadata === null) continue;
    for (const item of select(c.metadata)) out.add(item);
  }
  return out;
}

/** Highest CCN among lizard functions overlapping the range; null when lizard is absent or nothing overlaps. */
function maxOverlappingCcn(
  lizard: LizardFileResult | null,
  startLine: number,
  endLine: number,
): number | null {
  if (lizard === null) return null;
  let max: number | null = null;
  for (const f of lizard.functions) {
    if (f.lineFrom > endLine || f.lineTo < startLine) continue;
    if (max === null || f.ccn > max) max = f.ccn;
  }
  return max;
}
