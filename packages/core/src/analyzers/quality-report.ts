/**
 * Project quality report (#525).
 *
 * One aggregation over everything the quality family produces:
 *
 *   - stored per-file findings from the `quality` analyzer's
 *     enrichment rows (god-file, long-params, deep-nesting,
 *     high-fan-out, stale-ref);
 *   - the query-time cross-file rules that must NOT live in per-file
 *     enrichment rows (they'd snapshot other files' state and never
 *     heal): `extract-candidate` over duplicate groups,
 *     `high-fan-in` over live reference counts, `low-cohesion` over
 *     chunk vectors, `doc-drift` for markdown against the code it
 *     references.
 *
 * Files rank by severity-weighted finding count. All inputs arrive
 * through the narrow {@link QualityReportPorts} so the module stays
 * pure of storage imports and testable with plain stubs; the MCP
 * `quality_report` tool and the web `/api/projects/:id/quality` route
 * adapt the runtime onto it.
 *
 * Every bound is explicit and surfaced: scan caps and doc caps append
 * warnings — no silent truncation.
 */

import { join } from "node:path";
import type { ProjectId } from "../models.js";
import { cohesionFlags, computeFileCohesion } from "./cohesion.js";
import { isLicenseLikePath } from "./duplicates.js";
import {
  type DuplicateGroupLike,
  extractCandidates,
  fanInFinding,
  type QualityThresholds,
} from "./quality.js";
import { isMarkdownPath, type MarkdownVectorPort, runDocDrift } from "./quality-markdown.js";
import type { RulePackFinding } from "./rule-pack.js";

/** Read-only data access the report needs; adapted from the runtime. */
export interface QualityReportPorts {
  /** Complete `quality` enrichment rows for the project. */
  qualityEnrichments(projectId: ProjectId): ReadonlyArray<{
    readonly fileId: string;
    readonly payloadJson: string;
  }>;
  /** Query-time duplicate groups (min distinct files applied by caller). */
  duplicateGroups(minMembers: number, projectId: ProjectId): ReadonlyArray<DuplicateGroupLike>;
  /** Live inbound-reference counts per defining file, one batch query. */
  fanInCounts(projectId: ProjectId): ReadonlyMap<string, number>;
  /** Chunk identities + vectors, row-capped. */
  scanChunks(
    projectId: ProjectId,
    limit: number,
  ): Promise<
    ReadonlyArray<{
      readonly chunkId: string;
      readonly fileId: string;
      readonly relPath: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly vector: ArrayLike<number>;
    }>
  >;
  /** Every indexed file of the project (fileId → relPath source of truth). */
  listFiles(
    projectId: ProjectId,
  ): ReadonlyArray<{ readonly fileId: string; readonly relPath: string }>;
  /** Doc content from disk; null when unreadable. */
  readFileContent(absPath: string): Promise<string | null>;
  /** Existence check for stale-ref resolution inside doc-drift. */
  exists(absPath: string): boolean;
  /** Vector access for doc-drift. */
  readonly vectors: MarkdownVectorPort;
}

export interface QualityReportOptions {
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly thresholds: QualityThresholds;
  /** Markdown rules toggle + drift floor (0..1), mirroring config. */
  readonly markdownRules: boolean;
  readonly driftFloor: number;
  /** Max files in the report. */
  readonly limit: number;
  /** Only include findings whose ruleId matches (exact). */
  readonly ruleFilter?: string;
  /** Chunk-scan cap for cohesion. */
  readonly scanCap?: number;
  /** Markdown docs examined for drift. */
  readonly maxDriftDocs?: number;
}

export interface QualityReportFile {
  readonly fileId: string;
  readonly relPath: string;
  /** Severity-weighted score: error 3, warning 2, info 1. */
  readonly weight: number;
  readonly findings: ReadonlyArray<RulePackFinding>;
}

/** Per-rule rollup across the WHOLE report, before any rule filter. */
export interface QualityRuleSummary {
  readonly ruleId: string;
  /** Total findings for this rule. */
  readonly count: number;
  /** Distinct files carrying it. */
  readonly files: number;
  readonly worstSeverity: RulePackFinding["severity"];
}

export interface QualityReport {
  readonly files: ReadonlyArray<QualityReportFile>;
  /**
   * Rule rollups sorted by count, computed BEFORE `ruleFilter` — a
   * filtered request still sees the full distribution, so UI widgets
   * built on this stay stable while drilling into one rule.
   */
  readonly rules: ReadonlyArray<QualityRuleSummary>;
  readonly totals: {
    readonly files: number;
    readonly findings: number;
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  };
  /** Coverage notes: caps hit, unreadable docs — never silent. */
  readonly notes: ReadonlyArray<string>;
}

const DEFAULT_SCAN_CAP = 4_000;
const DEFAULT_MAX_DRIFT_DOCS = 50;
/**
 * Display cap per file. A boilerplate-heavy file can sit in dozens of
 * duplicate groups; weight still counts every finding (the ranking
 * signal stays honest), but the response stays bounded.
 */
const MAX_FINDINGS_PER_FILE = 50;
const SEVERITY_WEIGHT: Readonly<Record<RulePackFinding["severity"], number>> = Object.freeze({
  error: 3,
  warning: 2,
  info: 1,
});
const SEVERITY_ORDER: Readonly<Record<RulePackFinding["severity"], number>> = Object.freeze({
  error: 0,
  warning: 1,
  info: 2,
});

export async function buildQualityReport(
  ports: QualityReportPorts,
  opts: QualityReportOptions,
): Promise<QualityReport> {
  const notes: string[] = [];
  const byFile = new Map<string, RulePackFinding[]>();
  const add = (fileId: string, finding: RulePackFinding): void => {
    const list = byFile.get(fileId) ?? [];
    list.push(finding);
    byFile.set(fileId, list);
  };

  const files = ports.listFiles(opts.projectId);
  const relPathById = new Map(files.map((f) => [f.fileId, f.relPath]));
  // Suffix resolver for docs-shorthand refs, built once from the file
  // list (exact path beats suffix; shortest suffix match wins).
  const relPaths = files.map((f) => f.relPath);
  const relPathSet = new Set(relPaths);
  const resolveSuffix = (ref: string): string | null => {
    if (relPathSet.has(ref)) return join(opts.projectRoot, ref);
    let best: string | null = null;
    for (const rp of relPaths) {
      if (rp.endsWith(`/${ref}`) && (best === null || rp.length < best.length)) best = rp;
    }
    return best === null ? null : join(opts.projectRoot, best);
  };

  // 1. Stored per-file findings from the quality analyzer's rows.
  for (const row of ports.qualityEnrichments(opts.projectId)) {
    try {
      const parsed = JSON.parse(row.payloadJson) as {
        findings?: ReadonlyArray<RulePackFinding>;
      };
      for (const f of parsed.findings ?? []) add(row.fileId, f);
    } catch {
      // One malformed payload must not sink the report.
      notes.push(`unparseable quality payload for file ${row.fileId} — skipped`);
    }
  }

  // 2. extract-candidate: third-caller duplication over query-time groups.
  for (const c of extractCandidates(ports.duplicateGroups(3, opts.projectId))) {
    const relPath = relPathById.get(c.fileId);
    if (relPath === undefined) continue; // group member no longer indexed
    // Legacy duplicates rows may predate the license skip — filter here
    // too so old enrichments can't reintroduce the noise.
    if (isLicenseLikePath(relPath)) continue;
    add(c.fileId, c.finding);
  }

  // 3. high-fan-in over live counts.
  for (const [fileId, count] of ports.fanInCounts(opts.projectId)) {
    if (!relPathById.has(fileId)) continue;
    const finding = fanInFinding(count, opts.thresholds);
    if (finding !== null) add(fileId, finding);
  }

  // 4. low-cohesion over chunk vectors.
  const scanCap = opts.scanCap ?? DEFAULT_SCAN_CAP;
  const scanned = await ports.scanChunks(opts.projectId, scanCap + 1);
  const truncated = scanned.length > scanCap;
  if (truncated) {
    notes.push(`cohesion scan capped at ${scanCap} chunks — coverage is partial`);
  }
  for (const flag of cohesionFlags(computeFileCohesion(scanned.slice(0, scanCap)))) {
    if (!relPathById.has(flag.fileId)) continue;
    add(flag.fileId, flag.finding);
  }

  // 5. doc-drift for markdown, capped.
  if (opts.markdownRules) {
    const maxDocs = opts.maxDriftDocs ?? DEFAULT_MAX_DRIFT_DOCS;
    const docs = files.filter((f) => isMarkdownPath(f.relPath));
    if (docs.length > maxDocs) {
      notes.push(`doc-drift examined ${maxDocs} of ${docs.length} markdown files`);
    }
    for (const doc of docs.slice(0, maxDocs)) {
      const absPath = join(opts.projectRoot, doc.relPath);
      const content = await ports.readFileContent(absPath);
      if (content === null) continue;
      const drift = await runDocDrift(content, absPath, {
        projectId: opts.projectId,
        projectRoot: opts.projectRoot,
        driftFloor: opts.driftFloor,
        exists: ports.exists,
        resolveSuffix,
        vectors: ports.vectors,
      });
      if (drift !== null) add(doc.fileId, drift);
    }
  }

  // Per-rule rollup over the FULL merge, before the rule filter.
  const ruleAgg = new Map<string, { count: number; fileIds: Set<string>; worst: number }>();
  for (const [fileId, all] of byFile.entries()) {
    if (!relPathById.has(fileId)) continue;
    for (const f of all) {
      const agg = ruleAgg.get(f.ruleId) ?? { count: 0, fileIds: new Set<string>(), worst: 2 };
      agg.count += 1;
      agg.fileIds.add(fileId);
      agg.worst = Math.min(agg.worst, SEVERITY_ORDER[f.severity]);
      ruleAgg.set(f.ruleId, agg);
    }
  }
  const severityAt = (order: number): RulePackFinding["severity"] =>
    order === 0 ? "error" : order === 1 ? "warning" : "info";
  const rules = [...ruleAgg.entries()]
    .map(([ruleId, a]) => ({
      ruleId,
      count: a.count,
      files: a.fileIds.size,
      worstSeverity: severityAt(a.worst),
    }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.ruleId.localeCompare(b.ruleId)));

  // Rank: severity-weighted per file, findings sorted severity → line.
  const ranked: QualityReportFile[] = [];
  const totals = { files: 0, findings: 0, errors: 0, warnings: 0, infos: 0 };
  for (const [fileId, all] of byFile.entries()) {
    const relPath = relPathById.get(fileId);
    if (relPath === undefined) continue;
    const findings =
      opts.ruleFilter === undefined ? all : all.filter((f) => f.ruleId === opts.ruleFilter);
    if (findings.length === 0) continue;
    findings.sort((a, b) => {
      const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      return sev !== 0 ? sev : a.lineFrom - b.lineFrom;
    });
    let weight = 0;
    for (const f of findings) {
      weight += SEVERITY_WEIGHT[f.severity];
      totals.findings += 1;
      if (f.severity === "error") totals.errors += 1;
      else if (f.severity === "warning") totals.warnings += 1;
      else totals.infos += 1;
    }
    if (findings.length > MAX_FINDINGS_PER_FILE) {
      notes.push(
        `${relPath}: showing ${MAX_FINDINGS_PER_FILE} of ${findings.length} findings (weight counts all)`,
      );
    }
    ranked.push({
      fileId,
      relPath,
      weight,
      findings: Object.freeze(findings.slice(0, MAX_FINDINGS_PER_FILE)),
    });
  }
  totals.files = ranked.length;
  ranked.sort((a, b) =>
    b.weight !== a.weight ? b.weight - a.weight : a.relPath.localeCompare(b.relPath),
  );

  return Object.freeze({
    files: Object.freeze(ranked.slice(0, Math.max(1, opts.limit))),
    rules: Object.freeze(rules),
    totals,
    notes: Object.freeze(notes),
  });
}
