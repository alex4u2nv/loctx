/**
 * "Value served" accounting for MCP retrieval calls (#value-metrics).
 *
 * Every search_workspace / find_usages / find_literal response points at
 * concrete files (relPath + projectId). Without loctx an agent would
 * grep, then read those whole files; with loctx it gets ranked snippets.
 * We estimate the difference — tokens saved, file reads avoided — and
 * accumulate it per project so the dashboard can show the value.
 *
 * It is an ESTIMATE, deliberately labelled as one in the UI:
 *   - baseline  = the full byte size of every matched file (what a
 *                 grep + read-whole-file fallback would pull).
 *   - returned  = the byte size of the snippet content loctx handed back.
 *   - saved     = baseline − returned. Content-vs-content, so metadata
 *                 scaffolding (scores, line numbers) counts for neither.
 * Conservative for semantic search: loctx surfaces files grep can't find
 * literally, so the true saving there is higher than credited. Bytes are
 * converted to tokens with a fixed heuristic — hence "≈" everywhere.
 */

export const USAGE_CHARS_PER_TOKEN = 4;

/** Tools whose responses map to files, i.e. have a grep + read baseline. */
export function isValueTool(tool: string): boolean {
  return tool === "search_workspace" || tool === "find_usages" || tool === "find_literal";
}

export interface ProjectQueryValue {
  readonly projectId: string;
  /** Full byte size of the unique matched files (the grep+read baseline). */
  readonly baselineBytes: number;
  /** Byte size of the snippet content loctx actually returned. */
  readonly returnedBytes: number;
  /** Unique files surfaced — reads the agent didn't have to make. */
  readonly filesReferenced: number;
}

export interface QueryValue {
  readonly byProject: ReadonlyArray<ProjectQueryValue>;
  readonly hadResults: boolean;
}

/** One row of accumulated value, keyed by project (`""` = workspace roll-up). */
export interface UsageDelta {
  readonly projectId: string;
  readonly queries: number;
  readonly resultsBytes: number;
  readonly baselineBytes: number;
  readonly filesReadAvoided: number;
  readonly zeroHitQueries: number;
  readonly elapsedMs: number;
}

type FileBytes = (projectId: string, relPath: string) => number | null;

interface Ref {
  readonly projectId: string;
  readonly relPath: string;
  readonly snippetBytes: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
function asArray(v: unknown): ReadonlyArray<unknown> {
  return Array.isArray(v) ? v : [];
}
function byteLen(v: unknown): number {
  return typeof v === "string" ? Buffer.byteLength(v, "utf8") : 0;
}

function extractRefs(tool: string, result: unknown): Ref[] {
  const r = asRecord(result);
  if (r === null) return [];
  const refs: Ref[] = [];
  const push = (pid: unknown, rp: unknown, snippet: unknown): void => {
    if (typeof pid === "string" && pid !== "" && typeof rp === "string" && rp !== "") {
      refs.push({ projectId: pid, relPath: rp, snippetBytes: byteLen(snippet) });
    }
  };
  if (tool === "search_workspace") {
    for (const x of asArray(r["results"])) {
      const row = asRecord(x);
      if (row !== null) push(row["projectId"], row["relPath"], row["snippet"]);
    }
  } else if (tool === "find_usages") {
    for (const p of asArray(r["projects"])) {
      const proj = asRecord(p);
      if (proj === null) continue;
      const pid = proj["projectId"];
      for (const h of [...asArray(proj["defs"]), ...asArray(proj["refs"])]) {
        const hit = asRecord(h);
        if (hit !== null) push(pid, hit["relPath"], hit["document"]);
      }
    }
  } else if (tool === "find_literal") {
    for (const m of asArray(r["matches"])) {
      const match = asRecord(m);
      if (match !== null) push(match["projectId"], match["relPath"], match["lineText"]);
    }
  }
  return refs;
}

/**
 * Estimate the value of one retrieval response. `fileBytes` looks up a
 * file's full size (typically `state.getFile(...).size`); files it can't
 * resolve contribute 0 to the baseline.
 */
export function estimateQueryValue(
  tool: string,
  result: unknown,
  fileBytes: FileBytes,
): QueryValue {
  const refs = extractRefs(tool, result);
  const filesByProject = new Map<string, Set<string>>();
  const returnedByProject = new Map<string, number>();
  for (const ref of refs) {
    const set = filesByProject.get(ref.projectId) ?? new Set<string>();
    set.add(ref.relPath);
    filesByProject.set(ref.projectId, set);
    returnedByProject.set(
      ref.projectId,
      (returnedByProject.get(ref.projectId) ?? 0) + ref.snippetBytes,
    );
  }
  const byProject: ProjectQueryValue[] = [];
  for (const [projectId, relPaths] of filesByProject) {
    let baselineBytes = 0;
    for (const relPath of relPaths) baselineBytes += fileBytes(projectId, relPath) ?? 0;
    byProject.push({
      projectId,
      baselineBytes,
      returnedBytes: returnedByProject.get(projectId) ?? 0,
      filesReferenced: relPaths.size,
    });
  }
  return Object.freeze({ byProject: Object.freeze(byProject), hadResults: refs.length > 0 });
}

/**
 * Turn a {@link QueryValue} into the per-project usage rows to accumulate:
 * a `""` workspace roll-up (authoritative for total queries / zero-hit /
 * latency) plus one row per project touched.
 */
export function toUsageDeltas(value: QueryValue, elapsedMs: number): UsageDelta[] {
  const sum = (pick: (p: ProjectQueryValue) => number): number =>
    value.byProject.reduce((acc, p) => acc + pick(p), 0);
  const deltas: UsageDelta[] = [
    {
      projectId: "",
      queries: 1,
      resultsBytes: sum((p) => p.returnedBytes),
      baselineBytes: sum((p) => p.baselineBytes),
      filesReadAvoided: sum((p) => p.filesReferenced),
      zeroHitQueries: value.hadResults ? 0 : 1,
      elapsedMs,
    },
  ];
  for (const p of value.byProject) {
    deltas.push({
      projectId: p.projectId,
      queries: 1,
      resultsBytes: p.returnedBytes,
      baselineBytes: p.baselineBytes,
      filesReadAvoided: p.filesReferenced,
      zeroHitQueries: 0,
      elapsedMs: 0,
    });
  }
  return deltas;
}

/** Bytes → estimated tokens with the fixed heuristic. */
export function bytesToTokens(bytes: number): number {
  return Math.round(bytes / USAGE_CHARS_PER_TOKEN);
}

/** One project's accumulated raw usage totals (`""` = workspace roll-up). */
export interface UsageStatRow {
  readonly projectId: string;
  readonly queries: number;
  readonly resultsBytes: number;
  readonly baselineBytes: number;
  readonly filesReadAvoided: number;
  readonly zeroHitQueries: number;
  readonly elapsedMs: number;
}

/** Display-ready value metrics derived from a {@link UsageStatRow}. */
export interface UsageSummary {
  readonly queries: number;
  readonly tokensSaved: number;
  readonly tokensReturned: number;
  readonly baselineTokens: number;
  /** Saved as a share of baseline, 0–100. */
  readonly reductionPct: number;
  readonly filesReadAvoided: number;
  readonly zeroHitQueries: number;
  /** Zero-hit queries as a share of all queries, 0–100. */
  readonly zeroHitPct: number;
  readonly avgLatencyMs: number;
}

export interface UsageReport {
  readonly workspace: UsageSummary;
  readonly byProject: ReadonlyArray<UsageSummary & { readonly projectId: string }>;
}

const EMPTY_ROW: UsageStatRow = {
  projectId: "",
  queries: 0,
  resultsBytes: 0,
  baselineBytes: 0,
  filesReadAvoided: 0,
  zeroHitQueries: 0,
  elapsedMs: 0,
};

function summarizeRow(r: UsageStatRow): UsageSummary {
  const baselineTokens = bytesToTokens(r.baselineBytes);
  const tokensReturned = bytesToTokens(r.resultsBytes);
  const tokensSaved = Math.max(0, baselineTokens - tokensReturned);
  return {
    queries: r.queries,
    tokensSaved,
    tokensReturned,
    baselineTokens,
    reductionPct: baselineTokens > 0 ? Math.round((100 * tokensSaved) / baselineTokens) : 0,
    filesReadAvoided: r.filesReadAvoided,
    zeroHitQueries: r.zeroHitQueries,
    zeroHitPct: r.queries > 0 ? Math.round((100 * r.zeroHitQueries) / r.queries) : 0,
    avgLatencyMs: r.queries > 0 ? Math.round(r.elapsedMs / r.queries) : 0,
  };
}

/**
 * Roll raw usage rows into a display-ready report: one workspace summary
 * (from the `""` row) plus a per-project list sorted by tokens saved.
 */
export function summarizeUsage(rows: ReadonlyArray<UsageStatRow>): UsageReport {
  const workspaceRow = rows.find((r) => r.projectId === "") ?? EMPTY_ROW;
  const byProject = rows
    .filter((r) => r.projectId !== "")
    .map((r) => ({ projectId: r.projectId, ...summarizeRow(r) }))
    .sort((a, b) => b.tokensSaved - a.tokensSaved);
  return { workspace: summarizeRow(workspaceRow), byProject };
}
