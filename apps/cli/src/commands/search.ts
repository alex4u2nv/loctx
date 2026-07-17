/**
 * `search` and `find-usages` — the read-side retrieval commands.
 */

import {
  buildRuntime,
  buildStateRuntime,
  DaemonHttpError,
  daemonClient,
  findSymbolUsages,
  readActiveDaemon,
  SearcherError,
} from "@loctx/core";
import type { Command } from "commander";
import { getCtx, loadConfigOrFail } from "../lib/context.js";
import { printSearchResponse, type SearchResultRow } from "../lib/print.js";

export function registerSearchCommands(program: Command): void {
  program
    .command("search <query>")
    .description(
      "Search the indexed workspace. Default scope is the current directory's project; " +
        "pass --path to scope to a specific project or subtree, --all to search everywhere.",
    )
    .option(
      "--path <p>",
      "Absolute or relative path to scope the search to (a project root or a subtree inside one).",
    )
    .option(
      "--all",
      "Search every indexed project, ignoring the current directory. Mutually exclusive with --path.",
      false,
    )
    .option("--limit <n>", "Maximum results", (v) => Number.parseInt(v, 10), 10)
    .option("--language <lang>", "Filter results to a single language.")
    .option(
      "--coverage",
      "Coverage mode: append callers/importers of each top hit with a coverageReason.",
      false,
    )
    .action(
      async (
        query: string,
        opts: {
          path?: string;
          all: boolean;
          limit: number;
          language?: string;
          coverage: boolean;
        },
      ) => {
        if (opts.path !== undefined && opts.all) {
          console.error("--path and --all are mutually exclusive.");
          process.exit(1);
        }
        const ctx = getCtx();
        const config = loadConfigOrFail(ctx);
        const scopePath = opts.all ? undefined : (opts.path ?? process.cwd());

        // Daemon-aware: when a daemon is running, hit /api/search so we
        // reuse the loaded ONNX embedding model (~90MB) and the live
        // reconciler status. Without this, every `loctx search` cold-
        // starts the embedding pipeline, adding 2-5s wall time to a
        // lookup the daemon could answer in 100ms. Local-runtime path
        // is preserved as a fallback for `loctx search` without a daemon.
        const lock = readActiveDaemon(config.paths.dataDir);
        if (lock !== null) {
          const client = daemonClient(config.paths.dataDir);
          const body: Record<string, unknown> = { query, limit: opts.limit };
          if (scopePath !== undefined) body["path"] = scopePath;
          if (opts.language !== undefined) body["language"] = opts.language;
          if (opts.coverage) body["coverage"] = true;
          try {
            const payload = await client.post<{
              resolvedScope: {
                mode: string;
                project: { id: string; name: string } | null;
                relPrefix: string | null;
              };
              results: ReadonlyArray<SearchResultRow>;
              warnings: ReadonlyArray<string>;
            }>("/api/search", body);
            printSearchResponse(payload);
            return;
          } catch (err) {
            // Daemon returned 4xx/5xx or the post threw. Try local runtime
            // so a transient daemon issue doesn't leave the user empty-
            // handed when their query is otherwise valid.
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`# daemon call failed (${msg}); falling back to local runtime.`);
          }
        }

        const runtime = await buildRuntime(config);
        try {
          const response = await runtime.searcher.search({
            query,
            ...(scopePath !== undefined ? { path: scopePath } : {}),
            limit: opts.limit,
            ...(opts.language !== undefined ? { language: opts.language } : {}),
            ...(opts.coverage ? { coverage: true } : {}),
          });
          printSearchResponse({
            resolvedScope: {
              mode: response.resolvedScope.mode,
              project: response.resolvedScope.project
                ? {
                    id: response.resolvedScope.project.id,
                    name: response.resolvedScope.project.name,
                  }
                : null,
              relPrefix: response.resolvedScope.relPrefix,
            },
            results: response.results.map((r) => ({
              score: r.score,
              absPath: r.absPath,
              relPath: r.relPath,
              startLine: r.startLine,
              endLine: r.endLine,
              kind: r.kind,
              symbols: [...r.symbols],
              matchReasons: [...r.matchReasons],
              coverageReason: r.coverageReason,
              enrichments: {
                lizard: r.enrichments.lizard,
                findings: r.enrichments.findings.map((f) => ({ ...f })),
              },
              snippet: r.snippet,
            })),
            warnings: [...response.warnings],
          });
        } catch (err) {
          if (err instanceof SearcherError) {
            console.error(err.message);
            process.exit(1);
          }
          throw err;
        } finally {
          await runtime.close();
        }
      },
    );

  program
    .command("find-usages <symbol>")
    .description(
      "Cross-reference lookup for SYMBOL: every def + callsite + import. " +
        "Default scope is the project containing cwd; pass --path to scope " +
        "elsewhere or --all to search every indexed project.",
    )
    .option("--path <p>", "Absolute or relative path to scope to a specific project.")
    .option("--all", "Search every indexed project, ignoring the current directory.", false)
    .action(async (symbol: string, opts: { path?: string; all: boolean }) => {
      if (opts.path !== undefined && opts.all) {
        console.error("--path and --all are mutually exclusive.");
        process.exit(1);
      }
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);
      const scopePath = opts.all ? undefined : (opts.path ?? process.cwd());

      // Daemon-aware: when a daemon is running, hit /api/find-usages so we
      // share the loaded SQLite handle (and the reconciler's authoritative
      // status). The API also prepends the reconcile warning when a pass
      // is in flight (per #294), so the output is consistent across CLI
      // and admin UI paths. Falls back to a state-only runtime when the
      // daemon is stopped — symbol_refs is a pure SQLite read, so the
      // fallback skips the embedding model entirely (#448).
      const lock = readActiveDaemon(config.paths.dataDir);
      if (lock !== null) {
        const client = daemonClient(config.paths.dataDir);
        const body: { symbol: string; path?: string } = { symbol };
        if (scopePath !== undefined) body.path = scopePath;
        try {
          const payload = await client.post<{
            symbol: string;
            defs: Array<{
              projectName: string;
              relPath: string;
              chunkStartLine: number;
              kind: string;
            }>;
            refs: Array<{
              projectName: string;
              relPath: string;
              chunkStartLine: number;
              kind: string;
            }>;
            warnings?: ReadonlyArray<string>;
          }>("/api/find-usages", body);
          for (const w of payload.warnings ?? []) {
            console.error(`# warning: ${w}`);
          }
          // Group by project name to match the local-runtime output shape.
          const byProject = new Map<
            string,
            { defs: typeof payload.defs; refs: typeof payload.refs }
          >();
          for (const d of payload.defs) {
            const e = byProject.get(d.projectName) ?? { defs: [], refs: [] };
            (e.defs as Array<(typeof payload.defs)[number]>).push(d);
            byProject.set(d.projectName, e);
          }
          for (const r of payload.refs) {
            const e = byProject.get(r.projectName) ?? { defs: [], refs: [] };
            (e.refs as Array<(typeof payload.refs)[number]>).push(r);
            byProject.set(r.projectName, e);
          }
          for (const [name, { defs, refs }] of byProject) {
            console.log(`# project: ${name}  defs=${defs.length}  refs=${refs.length}`);
            for (const d of defs) {
              console.log(`  def  ${d.relPath}:${d.chunkStartLine}  [${d.kind}]`);
            }
            for (const r of refs) {
              console.log(`  ${r.kind.padEnd(5)} ${r.relPath}:${r.chunkStartLine}`);
            }
          }
          if (byProject.size === 0) {
            console.error(`# no matches for ${symbol}`);
          }
          return;
        } catch (err) {
          // 404 from /api/find-usages means path resolution failed — handle
          // that case explicitly via the typed status, not substring match.
          // Anything else falls through to the local runtime so a transient
          // daemon issue doesn't hide results.
          if (err instanceof DaemonHttpError && err.status === 404) {
            console.error(
              `# scope: ${scopePath} is not inside any indexed project; pass --all to search everywhere.`,
            );
            process.exit(1);
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`# daemon call failed (${msg}); falling back to local read.`);
        }
      }

      // No daemon (or daemon path failed): state-only runtime — SQLite +
      // discovery, no embedding warmup.
      const runtime = buildStateRuntime(config);
      try {
        // Shared resolve-scope → findSymbol sweep (#449): same #276
        // nested-package handling as the MCP tool and the REST endpoint.
        const result = findSymbolUsages(runtime.discovery, runtime.state, symbol, scopePath);
        if (result.kind === "outside-indexed") {
          console.error(
            `# scope: ${scopePath} is not inside any indexed project; pass --all to search everywhere.`,
          );
          process.exit(1);
        }
        for (const w of result.warnings) {
          console.error(`# warning: ${w}`);
        }

        let totalDefs = 0;
        let totalRefs = 0;
        for (const { project, defs, refs } of result.projects) {
          console.log(`# project: ${project.name}  defs=${defs.length}  refs=${refs.length}`);
          for (const d of defs) {
            const abs = `${project.root}/${d.relPath}`;
            console.log(`  def  ${abs}:${d.chunkStartLine}  [${d.kind}]`);
          }
          for (const r of refs) {
            const abs = `${project.root}/${r.relPath}`;
            console.log(`  ${r.kind.padEnd(5)} ${abs}:${r.chunkStartLine}`);
          }
          totalDefs += defs.length;
          totalRefs += refs.length;
        }
        if (totalDefs === 0 && totalRefs === 0) {
          console.error(`# no matches for ${symbol}`);
          process.exit(0);
        }
      } finally {
        runtime.close();
      }
    });
}
