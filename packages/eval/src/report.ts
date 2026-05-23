/**
 * Markdown report generator + delta-table compare.
 *
 * Output is markdown so it can land in PR comments and `cat` cleanly
 * in a terminal. No external templating — every section is a small
 * function returning a string array, joined at the end.
 */

import type { MetricSummary, RunResultJson } from "./types.js";

const METRIC_KEYS = [
  "hitAt1",
  "hitAt3",
  "hitAt10",
  "mrrAt10",
  "ndcgAt10",
  "recallAt20",
  "recallAt50",
] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

const METRIC_LABELS: Readonly<Record<MetricKey, string>> = {
  hitAt1: "Hit@1",
  hitAt3: "Hit@3",
  hitAt10: "Hit@10",
  mrrAt10: "MRR@10",
  ndcgAt10: "nDCG@10",
  recallAt20: "Recall@20",
  recallAt50: "Recall@50",
};

export function renderReport(run: RunResultJson): string {
  const sections: string[] = [];
  sections.push(`# loctx eval report — ${run.runId}`);
  sections.push("");
  sections.push(`- gold set: \`${run.goldenSet}\``);
  sections.push(`- corpus sha: \`${run.corpusSha}\``);
  sections.push(`- loctx sha: \`${run.loctxSha}\``);
  sections.push(`- embedder: \`${run.embedder}\``);
  sections.push(`- runtime: \`${run.runtime}\``);
  sections.push(`- chunking config: \`${run.chunkingConfig}\``);
  sections.push(`- retrieval config: \`${run.retrievalConfig}\``);
  sections.push(`- chunk-boundary hash: \`${run.chunkBoundaryHash}\``);
  sections.push(`- started: ${run.startedAt}`);
  sections.push(`- finished: ${run.finishedAt}`);
  sections.push("");
  sections.push("## Overall");
  sections.push("");
  sections.push(renderMetricsTable(run.metrics.overall));
  sections.push("");
  sections.push("## By query type");
  sections.push("");
  sections.push(renderByTypeTable(run.metrics.byQueryType));
  sections.push("");
  sections.push("## Per query");
  sections.push("");
  sections.push("| query_id | type | Hit@1 | Hit@3 | Hit@10 | MRR@10 | nDCG@10 | R@20 | R@50 |");
  sections.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of run.perQuery) {
    sections.push(
      `| \`${p.queryId}\` | ${p.queryType} | ${fmt(p.hitAt1)} | ${fmt(p.hitAt3)} | ${fmt(p.hitAt10)} | ${fmt(p.mrrAt10)} | ${fmt(p.ndcgAt10)} | ${fmt(p.recallAt20)} | ${fmt(p.recallAt50)} |`,
    );
  }
  sections.push("");
  return sections.join("\n");
}

function renderMetricsTable(m: MetricSummary): string {
  const rows: string[] = [];
  rows.push("| metric | value |");
  rows.push("| --- | --- |");
  for (const k of METRIC_KEYS) {
    rows.push(`| ${METRIC_LABELS[k]} | ${fmt(m[k])} |`);
  }
  return rows.join("\n");
}

function renderByTypeTable(byType: Readonly<Record<string, MetricSummary>>): string {
  const types = Object.keys(byType).sort();
  if (types.length === 0) return "_(no per-type rows)_";
  const header = ["| type |", ...METRIC_KEYS.map((k) => ` ${METRIC_LABELS[k]} |`)].join("");
  const sep = ["| --- |", ...METRIC_KEYS.map(() => " --- |")].join("");
  const rows: string[] = [header, sep];
  for (const t of types) {
    const m = byType[t];
    if (m === undefined) continue;
    const cells = METRIC_KEYS.map((k) => ` ${fmt(m[k])} |`).join("");
    rows.push(`| ${t} |${cells}`);
  }
  return rows.join("\n");
}

export function renderCompare(a: RunResultJson, b: RunResultJson): string {
  const sections: string[] = [];
  sections.push(`# loctx eval compare — ${a.runId} → ${b.runId}`);
  sections.push("");
  sections.push(`- gold set: \`${a.goldenSet}\` → \`${b.goldenSet}\``);
  sections.push(`- corpus: \`${a.corpusSha}\` → \`${b.corpusSha}\``);
  sections.push(`- loctx:  \`${a.loctxSha}\` → \`${b.loctxSha}\``);
  if (a.goldenSet !== b.goldenSet) {
    sections.push("");
    sections.push(
      `> warning: gold sets differ (\`${a.goldenSet}\` vs \`${b.goldenSet}\`); deltas are not a like-for-like comparison.`,
    );
  }
  if (a.corpusSha !== b.corpusSha) {
    sections.push(
      "> warning: corpus shas differ; chunking output likely changed, affecting span-overlap matches.",
    );
  }
  sections.push("");
  sections.push("## Overall delta");
  sections.push("");
  sections.push("| metric | a | b | Δ |");
  sections.push("| --- | --- | --- | --- |");
  for (const k of METRIC_KEYS) {
    const av = a.metrics.overall[k];
    const bv = b.metrics.overall[k];
    sections.push(`| ${METRIC_LABELS[k]} | ${fmt(av)} | ${fmt(bv)} | ${fmtDelta(bv - av)} |`);
  }
  sections.push("");
  sections.push("## By query type");
  sections.push("");
  const types = unionTypes(a.metrics.byQueryType, b.metrics.byQueryType);
  sections.push("| type | metric | a | b | Δ |");
  sections.push("| --- | --- | --- | --- | --- |");
  for (const t of types) {
    const am = a.metrics.byQueryType[t];
    const bm = b.metrics.byQueryType[t];
    for (const k of METRIC_KEYS) {
      const av = am?.[k] ?? 0;
      const bv = bm?.[k] ?? 0;
      sections.push(
        `| ${t} | ${METRIC_LABELS[k]} | ${fmt(av)} | ${fmt(bv)} | ${fmtDelta(bv - av)} |`,
      );
    }
  }
  return sections.join("\n");
}

function unionTypes(
  a: Readonly<Record<string, MetricSummary>>,
  b: Readonly<Record<string, MetricSummary>>,
): ReadonlyArray<string> {
  const out = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  return [...out].sort();
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function fmtDelta(n: number): string {
  if (n === 0) return "·";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(3)}`;
}
