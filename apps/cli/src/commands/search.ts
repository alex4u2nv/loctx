/**
 * `search` and `find-usages` — the read-side retrieval commands.
 */

import { DaemonHttpError, findSymbolUsages, SearcherError } from "@loctx/core";
import type { Command } from "commander";
import { EXIT, errorMessage, fail } from "../lib/context.js";
import { withDaemonOrLocal } from "../lib/daemon-io.js";
import {
  printSearchResponse,
  printUsages,
  type SearchResultRow,
  type UsageGroup,
} from "../lib/print.js";

interface SearchOptions {
  readonly path?: string;
  readonly all: boolean;
  readonly limit: number;
  readonly language?: string;
  readonly coverage: boolean;
}

/**
 * One request shape for both transports: posted as the /api/search JSON
 * body on the daemon path, passed to `searcher.search()` locally — so
 * the two paths can't drift on which options they honor.
 */
function searchRequest(
  query: string,
  scopePath: string | undefined,
  opts: SearchOptions,
): {
  readonly query: string;
  readonly limit: number;
  readonly path?: string;
  readonly language?: string;
  readonly coverage?: boolean;
} {
  return {
    query,
    limit: opts.limit,
    ...(scopePath !== undefined ? { path: scopePath } : {}),
    ...(opts.language !== undefined ? { language: opts.language } : {}),
    ...(opts.coverage ? { coverage: true } : {}),
  };
}

/** The daemon /api/find-usages row shape the CLI consumes. */
interface DaemonUsageRow {
  readonly projectName: string;
  readonly relPath: string;
  readonly chunkStartLine: number;
  readonly kind: string;
}

/**
 * Normalize the daemon's flat defs/refs lists into the per-project
 * groups the local path gets from `findSymbolUsages` (CLI-8,
 * 2026-08-06 audit) — `Map.groupBy` instead of the hand-rolled
 * accumulator with its readonly-defeating casts. Projects appear in
 * defs order first, then refs-only projects, matching the old output.
 */
function groupDaemonUsages(
  defs: ReadonlyArray<DaemonUsageRow>,
  refs: ReadonlyArray<DaemonUsageRow>,
): ReadonlyArray<UsageGroup> {
  const defsByProject = Map.groupBy(defs, (d) => d.projectName);
  const refsByProject = Map.groupBy(refs, (r) => r.projectName);
  const names = [...new Set([...defsByProject.keys(), ...refsByProject.keys()])];
  return names.map((name) => ({
    name,
    root: null,
    defs: defsByProject.get(name) ?? [],
    refs: refsByProject.get(name) ?? [],
  }));
}

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
    .action(async (query: string, opts: SearchOptions) => {
      if (opts.path !== undefined && opts.all) {
        fail("--path and --all are mutually exclusive.");
      }
      const scopePath = opts.all ? undefined : (opts.path ?? process.cwd());
      const request = searchRequest(query, scopePath, opts);

      // Daemon-aware: when a daemon is running, hit /api/search so we
      // reuse the loaded ONNX embedding model (~90MB) and the live
      // reconciler status. Without this, every `loctx search` cold-
      // starts the embedding pipeline, adding 2-5s wall time to a
      // lookup the daemon could answer in 100ms. Local-runtime path
      // is preserved as a fallback for `loctx search` without a daemon.
      await withDaemonOrLocal({
        localRuntime: "full",
        viaDaemon: async (client) => {
          const payload = await client.post<{
            resolvedScope: {
              mode: string;
              project: { id: string; name: string } | null;
              relPrefix: string | null;
            };
            results: ReadonlyArray<SearchResultRow>;
            warnings: ReadonlyArray<string>;
          }>("/api/search", request);
          printSearchResponse(payload);
        },
        // Daemon returned 4xx/5xx or the post threw. Try local runtime
        // so a transient daemon issue doesn't leave the user empty-
        // handed when their query is otherwise valid.
        fallbackOnError: (err) => {
          console.error(
            `# daemon call failed (${errorMessage(err)}); falling back to local runtime.`,
          );
          return true;
        },
        viaLocal: async (runtime) => {
          try {
            // SearchResultRow is a Pick over the core SearchResult
            // (CLI-6), so the response passes through untranslated.
            printSearchResponse(await runtime.searcher.search(request));
          } catch (err) {
            if (err instanceof SearcherError) {
              // exitCode + return (not process.exit) so the runtime
              // close in withDaemonOrLocal's finally still runs (CLI-7).
              console.error(err.message);
              process.exitCode = EXIT.error;
              return;
            }
            throw err;
          }
        },
      });
    });

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
        fail("--path and --all are mutually exclusive.");
      }
      const scopePath = opts.all ? undefined : (opts.path ?? process.cwd());
      const scopeError = `# scope: ${scopePath} is not inside any indexed project; pass --all to search everywhere.`;

      // Daemon-aware: when a daemon is running, hit /api/find-usages so we
      // share the loaded SQLite handle (and the reconciler's authoritative
      // status). The API also prepends the reconcile warning when a pass
      // is in flight (per #294), so the output is consistent across CLI
      // and admin UI paths. Falls back to a state-only runtime when the
      // daemon is stopped — symbol_refs is a pure SQLite read, so the
      // fallback skips the embedding model entirely (#448).
      await withDaemonOrLocal({
        localRuntime: "state",
        viaDaemon: async (client) => {
          const body: { symbol: string; path?: string } = { symbol };
          if (scopePath !== undefined) body.path = scopePath;
          const payload = await client.post<{
            symbol: string;
            defs: ReadonlyArray<DaemonUsageRow>;
            refs: ReadonlyArray<DaemonUsageRow>;
            warnings?: ReadonlyArray<string>;
          }>("/api/find-usages", body);
          for (const w of payload.warnings ?? []) {
            console.error(`# warning: ${w}`);
          }
          // The daemon payload carries no project roots, so this path
          // prints relative paths — same as before the CLI-8 merge.
          const groups = groupDaemonUsages(payload.defs, payload.refs);
          printUsages(groups, { absolute: false });
          if (groups.length === 0) {
            console.error(`# no matches for ${symbol}`);
          }
        },
        // 404 from /api/find-usages means path resolution failed — handle
        // that case explicitly via the typed status, not substring match.
        // Anything else falls through to the local runtime so a transient
        // daemon issue doesn't hide results.
        fallbackOnError: (err) => {
          if (err instanceof DaemonHttpError && err.status === 404) {
            fail(scopeError);
          }
          console.error(`# daemon call failed (${errorMessage(err)}); falling back to local read.`);
          return true;
        },
        viaLocal: async (runtime) => {
          // Shared resolve-scope → findSymbol sweep (#449): same #276
          // nested-package handling as the MCP tool and the REST endpoint.
          const result = findSymbolUsages(runtime.discovery, runtime.state, symbol, scopePath);
          if (result.kind === "outside-indexed") {
            // exitCode + return (not process.exit) so the state store
            // close in withDaemonOrLocal's finally still runs (CLI-7).
            console.error(scopeError);
            process.exitCode = EXIT.error;
            return;
          }
          for (const w of result.warnings) {
            console.error(`# warning: ${w}`);
          }
          const groups: ReadonlyArray<UsageGroup> = result.projects.map(
            ({ project, defs, refs }) => ({ name: project.name, root: project.root, defs, refs }),
          );
          printUsages(groups, { absolute: true });
          if (groups.length === 0) {
            console.error(`# no matches for ${symbol}`);
          }
        },
      });
    });
}
