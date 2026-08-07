/**
 * Stdout formatting helpers shared by the search and config commands.
 */

import type { Config, SearchResult } from "@loctx/core";

/**
 * The subset of the core searcher's {@link SearchResult} the CLI
 * renders. Defined via `Pick` (CLI-6, 2026-08-06 audit) so the local
 * search path can pass `response.results` straight through instead of
 * re-listing all eleven fields to satisfy a structurally-identical
 * local type; the daemon path's JSON payload decodes into the same
 * shape. `matchReasons` widens to plain strings — the daemon boundary
 * is JSON, so the CLI must not trust the `MatchReason` union.
 */
export type SearchResultRow = Pick<
  SearchResult,
  | "score"
  | "absPath"
  | "relPath"
  | "startLine"
  | "endLine"
  | "kind"
  | "symbols"
  | "coverageReason"
  | "enrichments"
  | "snippet"
> & { readonly matchReasons: ReadonlyArray<string> };

export function clip(text: string, maxLines = 12): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join("\n");
}

export function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export function printSearchResponse(payload: {
  readonly resolvedScope: {
    readonly mode: string;
    readonly project: { readonly id: string; readonly name: string } | null;
    readonly relPrefix: string | null;
  };
  readonly results: ReadonlyArray<SearchResultRow>;
  readonly warnings: ReadonlyArray<string>;
}): void {
  const scopeLabel = [
    payload.resolvedScope.mode,
    payload.resolvedScope.project ? `(${payload.resolvedScope.project.name})` : "",
    payload.resolvedScope.relPrefix ? `#${payload.resolvedScope.relPrefix}` : "",
  ].join("");
  console.log(`# scope: ${scopeLabel}  results: ${payload.results.length}`);
  for (const warning of payload.warnings) {
    console.error(`# warning: ${warning}`);
  }
  for (const result of payload.results) {
    const path = result.absPath ?? result.relPath;
    const header = [
      `${result.score.toFixed(3)}  ${path}:${result.startLine}-${result.endLine}  [${result.kind}]`,
      result.symbols.length > 0 ? `  ${result.symbols.join(", ")}` : "",
    ].join("");
    console.log(header);
    if (result.matchReasons.length > 0) {
      console.log(`    # why: ${result.matchReasons.join(", ")}`);
    }
    if (result.coverageReason !== null) {
      console.log(`    # coverage: ${result.coverageReason}`);
    }
    if (result.enrichments.lizard !== null) {
      const l = result.enrichments.lizard;
      console.log(
        `    # complexity: fn=${l.functionName} ccn=${l.ccn} nloc=${l.nloc} tokens=${l.tokens} params=${l.parameters}`,
      );
    }
    for (const f of result.enrichments.findings) {
      const tag = f.category === "" ? f.severity : `${f.severity}/${f.category}`;
      const msg = f.message === "" ? "" : `: ${f.message}`;
      console.log(`    # ${f.analyzer} ${tag} ${f.ruleId} L${f.lineFrom}-${f.lineTo}${msg}`);
    }
    console.log(indent(clip(result.snippet)));
    console.log();
  }
}

/** One def/ref row as the usages printer needs it. */
export interface UsageRow {
  readonly relPath: string;
  readonly chunkStartLine: number;
  readonly kind: string;
}

/** Per-project def/ref groups for {@link printUsages}. */
export interface UsageGroup {
  readonly name: string;
  /** Project root for absolute rendering; null when unknown (daemon payload). */
  readonly root: string | null;
  readonly defs: ReadonlyArray<UsageRow>;
  readonly refs: ReadonlyArray<UsageRow>;
}

/**
 * The one find-usages renderer (CLI-8, 2026-08-06 audit) — the daemon
 * and local paths used to print near-identical tables from separate
 * loops. Format follows the local path's: `absolute: true` joins each
 * row onto its project root; the daemon payload carries no roots, so
 * that path stays relative (`absolute: false`), exactly as before.
 */
export function printUsages(
  groups: ReadonlyArray<UsageGroup>,
  options: { readonly absolute: boolean },
): void {
  for (const { name, root, defs, refs } of groups) {
    const render = (relPath: string): string =>
      options.absolute && root !== null ? `${root}/${relPath}` : relPath;
    console.log(`# project: ${name}  defs=${defs.length}  refs=${refs.length}`);
    for (const d of defs) {
      console.log(`  def  ${render(d.relPath)}:${d.chunkStartLine}  [${d.kind}]`);
    }
    for (const r of refs) {
      console.log(`  ${r.kind.padEnd(5)} ${render(r.relPath)}:${r.chunkStartLine}`);
    }
  }
}

export function printConfig(config: Config): void {
  // Pretty-print every leaf with its source. "(derived)" is reserved for
  // path fields computed from dataDir — they have no independent source.
  const tag = (key: string): string => {
    const s = config.sources[key];
    return s ? `[${s}]` : "[derived]";
  };
  const row = (label: string, value: string | number | boolean, source: string): string =>
    `  ${label.padEnd(22)}: ${String(value).padEnd(48)} ${source}`;

  console.log("loctx config (effective):");
  console.log(`  global file           : ${config.source ?? "(none)"}`);
  console.log("");
  console.log("workspace_roots:");
  for (const root of config.workspaceRoots) {
    console.log(`  - ${root.padEnd(60)} ${tag("workspaceRoots")}`);
  }
  console.log("");
  console.log("paths:");
  console.log(row("dataDir", config.paths.dataDir, tag("paths.dataDir")));
  console.log(row("configDir", config.paths.configDir, tag("paths.configDir")));
  console.log(row("vectorDir", config.paths.vectorDir, "[derived]"));
  console.log(row("stateDb", config.paths.stateDb, "[derived]"));
  console.log(row("logsDir", config.paths.logsDir, "[derived]"));
  console.log("");
  console.log("embedding:");
  console.log(row("provider", config.embedding.provider, tag("embedding.provider")));
  console.log(row("model", config.embedding.model, tag("embedding.model")));
  console.log(row("normalize", config.embedding.normalize, tag("embedding.normalize")));
  console.log("");
  console.log("watcher:");
  console.log(row("debounceMs", config.watcher.debounceMs, tag("watcher.debounceMs")));
  console.log("");
  console.log("daemon:");
  console.log(row("port", config.daemon.port, tag("daemon.port")));
  console.log(row("hostname", config.daemon.hostname, tag("daemon.hostname")));
  console.log("");
  console.log("retrieval:");
  console.log(row("mode", config.retrieval.mode, tag("retrieval.mode")));
  console.log(row("rrfK", config.retrieval.rrfK, tag("retrieval.rrfK")));
}
