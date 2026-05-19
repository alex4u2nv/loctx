#!/usr/bin/env node
/**
 * Commander CLI entry points for loctx.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type Config,
  ConfigError,
  DaemonHttpError,
  DaemonLockHeldError,
  NoDaemonError,
  type Project,
  SearcherError,
  StateStore,
  WatcherService,
  WorkspaceDiscovery,
  buildRuntime,
  daemonClient,
  defaultConfigFile,
  findContainingProject,
  inventoryProjects,
  loadConfig,
  makeProject,
  readActiveDaemon,
  runDoctorChecks,
  stopActiveDaemon,
  worstStatus,
} from "@loctx/core";
import { Command } from "commander";

const VERSION = "0.1.0";

interface CliContext {
  readonly configPath: string;
  readonly debug: boolean;
}

function unimplemented(name: string, note?: string): never {
  console.error(`loctx ${name}: not yet implemented${note ? ` ${note}` : ""}`);
  process.exit(2);
}

function loadConfigOrFail(ctx: CliContext): Config {
  try {
    return loadConfig(ctx.configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// ---- main program ------------------------------------------------------

const program = new Command()
  .name("loctx")
  .description("Local-first code indexing and search for MCP-capable agents.")
  .version(VERSION, "-V, --version")
  .option(
    "-c, --config <path>",
    "Path to a loctx config YAML. Defaults to $XDG_CONFIG_HOME/loctx/config.yaml.",
  )
  .option("--debug", "Enable verbose logging.", false);

function getCtx(): CliContext {
  const opts = program.opts<{ config?: string; debug?: boolean }>();
  return Object.freeze({
    configPath: opts.config ?? defaultConfigFile().replace(/\.toml$/, ".yaml"),
    debug: opts.debug ?? false,
  });
}

/**
 * Resolve the user's PATH argument to a concrete project root. Used by
 * every command that operates on "a project" — `add`, `activate`,
 * `deactivate`, `pause`, `resume`, `rebuild`, `purge`.
 *
 *   - `undefined` (no arg) or `"."` → walk up from `process.cwd()`
 *   - any other value             → walk up from `resolve(value)`
 *
 * Walking up means: if the supplied directory isn't itself a project
 * root, climb parents until a marker (`.git`, `package.json`, …) is
 * found. So `loctx add` works from `proj/src/components/` the same way
 * `loctx add ~/code/proj` does. Returns `null` when no marker exists
 * anywhere on the chain — callers should error with a helpful message.
 */
function resolveCommandPath(input: string | undefined): Project | null {
  const start = input === undefined || input === "." ? process.cwd() : resolve(input);
  return findContainingProject(start);
}

/**
 * Print a y/N confirmation prompt. Enter → "no" (safe default).
 * Reads from /dev/tty when stdin is piped so test-driven invocations
 * with no controlling terminal still error gracefully (caller passes
 * `--yes`). Async because readline-question is callback-based.
 */
async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((res) => {
      rl.question(`${message} [y/N] `, (a) => res(a));
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---- index --------------------------------------------------------------

program
  .command("index [path]")
  .description(
    "Index a project (or every active project if PATH is omitted). " +
      "An explicit PATH also activates the project — `loctx index <path>` is the " +
      "one-step opt-in for newly-discovered projects.",
  )
  .action(async (path?: string) => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);

    // Daemon-aware: building our own ProjectIndexer while the daemon is
    // running means two processes call mergeInsert / deleteFileChunks on
    // the same LanceDB project (#322). Refuse upfront unless the user
    // really wants foreground-only — point at the right command per
    // intent (activate a new project vs. force a reconcile pass).
    const daemonLock = readActiveDaemon(config.paths.dataDir);
    if (daemonLock !== null) {
      if (path !== undefined) {
        console.error(
          `[loctx index] daemon is running (PID ${daemonLock.pid}). Use \`loctx activate ${path}\` to onboard a new project — it activates AND kicks off the initial index against the live daemon, so writes stay coordinated.`,
        );
      } else {
        console.error(
          `[loctx index] daemon is running (PID ${daemonLock.pid}). The daemon's reconciler walks all active projects on its own; \`loctx refresh\` triggers it explicitly, or wait for the periodic pass.`,
        );
        console.error(
          "[loctx index]   Running `loctx index` in parallel would race the daemon's writers on the same LanceDB collection.",
        );
      }
      console.error(
        "[loctx index]   To run a foreground index pass: `loctx stop`, `loctx index`, `loctx start`.",
      );
      process.exit(1);
    }

    const runtime = await buildRuntime(config);
    try {
      let projects: Project[];
      if (path !== undefined) {
        // Explicit path: index it, and activate it as a side effect so
        // future `loctx index` / daemon runs include it automatically.
        const project = makeProject(resolve(path));
        runtime.state.upsertProjectWithActive(project, true);
        projects = [project];
      } else {
        // No path: index only currently-active projects. Discovered-but-
        // inactive ones stay alone until the user opts in.
        const inv = inventoryProjects(runtime.discovery, runtime.state);
        projects = inv.active.map((a) => a.project);
        if (projects.length === 0 && inv.inactive.length > 0) {
          console.error(
            `No active projects. ${inv.inactive.length} discovered but inactive — run \`loctx activate <path>\` to opt one in.`,
          );
          process.exit(1);
        }
      }
      if (projects.length === 0) {
        console.error("No projects found. Pass an explicit PATH or configure workspace_roots.");
        process.exit(1);
      }
      for (const project of projects) {
        console.log(`Indexing ${project.name} (${project.root}) ...`);
        const summary = await runtime.indexer.indexProject(project);
        console.log(
          `  indexed=${summary.indexed} skipped=${summary.skipped} ` +
            `failed=${summary.failed} (${summary.elapsedSeconds.toFixed(2)}s)`,
        );
        for (const failure of summary.failures.slice(0, 5)) {
          if (failure.kind === "error") {
            console.log(`    ! ${failure.relPath}: ${failure.error}`);
          }
        }
        if (summary.failures.length > 5) {
          console.log(`    ... and ${summary.failures.length - 5} more`);
        }
      }
    } finally {
      await runtime.close();
    }
  });

// ---- refresh ------------------------------------------------------------

program
  .command("refresh")
  .description(
    "Force the daemon's reconciler to walk every active project NOW " +
      "(prunes deleted files, re-evaluates filters, re-indexes drift). " +
      "Requires a running daemon — refuses with 409 if one is already in flight.",
  )
  .action(async () => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const lock = readActiveDaemon(config.paths.dataDir);
    if (lock === null) {
      console.error(
        "[loctx refresh] no daemon running. Start one with `loctx start`, or run `loctx index` for a one-shot foreground pass.",
      );
      process.exit(1);
    }
    const client = daemonClient(config.paths.dataDir);
    try {
      const r = await client.post<{
        summaries: Array<{ projectId: string; name: string; pruned: number; reindexed: number }>;
      }>("/api/refresh", {});
      for (const s of r.summaries) {
        console.log(`refreshed ${s.name}: pruned=${s.pruned} reindexed=${s.reindexed}`);
      }
    } catch (err) {
      // /api/refresh returns 409 mid-reconcile (#312) with the live
      // progress in the body. Use a typed check, not substring matching,
      // so a transient 5xx with "409" coincidentally in its body can't
      // get classified as a soft conflict.
      if (err instanceof DaemonHttpError && err.status === 409) {
        console.error(`[loctx refresh] daemon 409: ${err.body.trim()}`);
        console.error(
          "[loctx refresh]   The reconciler is already running — see `loctx status` for progress.",
        );
        process.exit(2);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[loctx refresh] failed: ${msg}`);
      process.exit(1);
    }
  });

// ---- add / activate / deactivate ---------------------------------------

/**
 * `loctx add` is the friendly entry point: run it from anywhere inside
 * a project (or pass an explicit PATH) and it walks up to the nearest
 * marker, confirms with the user, then activates indexing. `activate`
 * is kept as a non-interactive synonym for scripts and existing muscle
 * memory.
 */
async function runActivate(project: Project, ctx: CliContext): Promise<void> {
  const config = loadConfigOrFail(ctx);
  const lock = readActiveDaemon(config.paths.dataDir);
  if (lock !== null) {
    const client = daemonClient(config.paths.dataDir);
    await client.post("/api/projects/activate", { path: project.root });
    console.error(`[loctx activate] ${project.name} (${project.root}) — via daemon`);
    return;
  }
  const runtime = await buildRuntime(config);
  try {
    runtime.state.upsertProjectWithActive(project, true);
    console.error(`[loctx activate] ${project.name} (${project.root})`);
    const summary = await runtime.indexer.indexProject(project);
    console.error(
      `[loctx activate] initial index: indexed=${summary.indexed} skipped=${summary.skipped} failed=${summary.failed}`,
    );
  } finally {
    await runtime.close();
  }
}

program
  .command("add [path]")
  .description(
    "Activate the project containing PATH (or cwd) for indexing + watching. " +
      "Walks up to the nearest project marker (.git, package.json, …), prompts " +
      "for confirmation, then runs an initial index pass.",
  )
  .option("-y, --yes", "Skip the confirmation prompt.", false)
  .action(async (path: string | undefined, opts: { yes: boolean }) => {
    const project = resolveCommandPath(path);
    if (project === null) {
      const start = path === undefined || path === "." ? process.cwd() : resolve(path);
      console.error(
        `[loctx add] no project marker found at or above ${start}.\n  Expected one of: .git, .vscode, .idea, package.json, pyproject.toml, Cargo.toml, go.mod, …`,
      );
      process.exit(1);
    }
    console.error(`[loctx add] resolved project: ${project.name} (${project.root})`);
    if (!opts.yes) {
      const ok = await confirm("Activate indexing for this project?");
      if (!ok) {
        console.error("[loctx add] aborted.");
        process.exit(1);
      }
    }
    await runActivate(project, getCtx());
  });

program
  .command("activate [path]")
  .description(
    "Activate a project for indexing + watching. Non-interactive synonym for `loctx add -y`. " +
      "PATH may be omitted or `.` to use the project containing cwd.",
  )
  .action(async (path: string | undefined) => {
    const project = resolveCommandPath(path);
    if (project === null) {
      const start = path === undefined || path === "." ? process.cwd() : resolve(path);
      console.error(`[loctx activate] no project marker found at or above ${start}.`);
      process.exit(1);
    }
    await runActivate(project, getCtx());
  });

program
  .command("deactivate [path]")
  .description(
    "Stop indexing + watching a project. PATH may be omitted or `.` to use the project containing cwd. " +
      "Indexed data stays (use `loctx purge` to remove).",
  )
  .action(async (path: string | undefined) => {
    const project = resolveCommandPath(path);
    if (project === null) {
      const start = path === undefined || path === "." ? process.cwd() : resolve(path);
      console.error(`[loctx deactivate] no project marker found at or above ${start}.`);
      process.exit(1);
    }
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const lock = readActiveDaemon(config.paths.dataDir);
    if (lock !== null) {
      const client = daemonClient(config.paths.dataDir);
      await client.post("/api/projects/deactivate", { path: project.root });
      console.error(`[loctx deactivate] ${project.name} (${project.root}) — via daemon`);
      return;
    }
    const state = new StateStore(config.paths.stateDb);
    try {
      const ok = state.setProjectActive(project.id, false);
      if (!ok) {
        console.error(
          `[loctx deactivate] no state row for ${project.root} — nothing to deactivate.`,
        );
        process.exit(1);
      }
      console.error(`[loctx deactivate] ${project.name} (${project.root})`);
    } finally {
      state.close();
    }
  });

// ---- search -------------------------------------------------------------

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

interface SearchResultRow {
  readonly score: number;
  readonly absPath: string | null;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  readonly symbols: ReadonlyArray<string>;
  readonly matchReasons: ReadonlyArray<string>;
  readonly coverageReason: string | null;
  readonly enrichments: {
    readonly lizard: {
      readonly functionName: string;
      readonly ccn: number;
      readonly nloc: number;
      readonly tokens: number;
      readonly parameters: number;
    } | null;
    readonly findings: ReadonlyArray<{
      readonly analyzer: string;
      readonly severity: string;
      readonly category: string;
      readonly ruleId: string;
      readonly message: string;
      readonly lineFrom: number;
      readonly lineTo: number;
    }>;
  };
  readonly snippet: string;
}

function printSearchResponse(payload: {
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
    // and admin UI paths. Falls back to a local runtime when the daemon
    // is stopped — symbol_refs is a pure SQLite read so we DON'T need
    // to spin up the embedding model just for find-usages.
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

    // No daemon (or daemon path failed): build a minimal runtime.
    const runtime = await buildRuntime(config);
    try {
      let projects = runtime.discovery.discoverProjects();
      if (scopePath !== undefined) {
        const scoped = runtime.discovery.resolveProject(scopePath);
        if (scoped === null) {
          console.error(
            `# scope: ${scopePath} is not inside any indexed project; pass --all to search everywhere.`,
          );
          process.exit(1);
        }
        projects = [scoped];
      }

      let totalDefs = 0;
      let totalRefs = 0;
      for (const project of projects) {
        const { defs, refs } = runtime.state.findSymbol(project.id, symbol);
        if (defs.length === 0 && refs.length === 0) continue;
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
      await runtime.close();
    }
  });

function clip(text: string, maxLines = 12): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function printConfig(config: Config): void {
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

// ---- start --------------------------------------------------------------

program
  .command("start")
  .description(
    "Run the integrated daemon: watcher + Next.js admin UI + MCP at /mcp on one port. " +
      "Port and hostname come from `daemon.port` / `daemon.hostname` in config.",
  )
  .option("--no-watch", "Skip the filesystem watcher.")
  .option("--no-web", "Skip the Next.js admin UI / MCP HTTP transport.")
  .option("--replace", "Stop any existing daemon for this data dir before starting.", false)
  .action(async (opts: { watch: boolean; web: boolean; replace: boolean }) => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const { start: runStart } = await import("./start.js");
    try {
      await runStart(config, {
        enableWatch: opts.watch,
        enableWeb: opts.web,
        replace: opts.replace,
      });
    } catch (err) {
      if (err instanceof DaemonLockHeldError) {
        console.error(err.message);
        console.error("Use `loctx start --replace` or `loctx restart` to take over.");
        process.exit(1);
      }
      throw err;
    }
  });

// ---- stop ---------------------------------------------------------------

program
  .command("stop")
  .description("Stop the loctx daemon for the configured data dir.")
  .option(
    "--timeout <ms>",
    "Milliseconds to wait for graceful shutdown before SIGKILL.",
    (v) => Number.parseInt(v, 10),
    8_000,
  )
  .action(async (opts: { timeout: number }) => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const stopped = await stopActiveDaemon(config.paths.dataDir, { timeoutMs: opts.timeout });
    if (stopped === null) {
      console.error("[loctx stop] no running daemon found.");
      return;
    }
    console.error(`[loctx stop] terminated daemon PID ${stopped.pid}.`);
  });

// ---- restart ------------------------------------------------------------

program
  .command("restart")
  .description("Stop any running daemon for this data dir, then start a new one.")
  .option("--no-watch", "Skip the filesystem watcher.")
  .option("--no-web", "Skip the Next.js admin UI / MCP HTTP transport.")
  .action(async (opts: { watch: boolean; web: boolean }) => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const { start: runStart } = await import("./start.js");
    await runStart(config, {
      enableWatch: opts.watch,
      enableWeb: opts.web,
      replace: true,
    });
  });

// ---- watch --------------------------------------------------------------

program
  .command("watch")
  .description("Run a foreground watcher that reindexes files on every change.")
  .option("--path <path>", "Watch a single project root instead of every discovered project.")
  .action(async (opts: { path?: string }) => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    // Refuse to run a second watcher while the daemon owns the same
    // data dir. LanceDB writers don't coordinate across processes —
    // two processes calling mergeInsert on the same project corrupt
    // each other (the per-fileId mutex inside ProjectIndexer is
    // in-memory). The daemon already watches your projects; running
    // `loctx watch` alongside it doubles the embedding work and
    // races on writes.
    const daemonLock = readActiveDaemon(config.paths.dataDir);
    if (daemonLock !== null) {
      console.error(
        `[loctx watch] daemon is running (PID ${daemonLock.pid}). The daemon already watches every active project — running a second foreground watcher would race on LanceDB writes.`,
      );
      console.error(
        "[loctx watch]   To watch in foreground only: `loctx stop` first, then `loctx watch`.",
      );
      console.error(
        "[loctx watch]   To see daemon activity: `loctx status` or http://localhost:3000/.",
      );
      process.exit(1);
    }
    const runtime = await buildRuntime(config);
    try {
      const projects = opts.path
        ? [makeProject(resolve(opts.path))]
        : runtime.discovery.discoverProjects();
      if (projects.length === 0) {
        console.error("No projects to watch.");
        process.exit(1);
      }

      const watchers = await Promise.all(
        projects.map(async (project) => {
          const w = new WatcherService(project, runtime.indexer, {
            onEvent: (event, relPath) => console.log(`${event}\t${project.name}/${relPath}`),
          });
          await w.start();
          return w;
        }),
      );
      console.error(`[loctx watch] running on ${projects.length} project(s); Ctrl+C to stop.`);

      await new Promise<void>((resolve) => {
        const onSignal = () => {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          resolve();
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
      });

      console.error("\n[loctx watch] shutting down...");
      await Promise.allSettled(watchers.map((w) => w.stop()));
    } finally {
      await runtime.close();
    }
  });

// ---- pause / resume / rebuild / purge (daemon-aware project ops) -------

program
  .command("pause [path]")
  .description(
    "Pause the watcher for the project at PATH (or containing cwd). " +
      "Use `--all` to pause every project. Requires a running daemon.",
  )
  .option("--all", "Pause every project's watcher.", false)
  .action(async (path: string | undefined, opts: { all: boolean }) => {
    await withDaemonClient(async (client) => {
      const targets = await resolveScopedTargets(client, path, opts.all, "pause");
      for (const t of targets) {
        await client.post("/api/watch/pause", { projectId: t.id });
        console.error(`[loctx pause] ${t.name} (${t.id})`);
      }
    });
  });

program
  .command("resume [path]")
  .description(
    "Resume the watcher for the project at PATH (or containing cwd). " +
      "Use `--all` to resume every project. Requires a running daemon.",
  )
  .option("--all", "Resume every project's watcher.", false)
  .action(async (path: string | undefined, opts: { all: boolean }) => {
    await withDaemonClient(async (client) => {
      const targets = await resolveScopedTargets(client, path, opts.all, "resume");
      for (const t of targets) {
        await client.post("/api/watch/resume", { projectId: t.id });
        console.error(`[loctx resume] ${t.name} (${t.id})`);
      }
    });
  });

program
  .command("rebuild [path]")
  .description(
    "Wipe and re-index the project at PATH (or containing cwd). Use `--all` to rebuild every project. " +
      "This clears the project's vectors + SQLite rows first so every file is re-indexed from scratch — " +
      "the only path that re-fires the analyzer queue (lizard, duplicates, semgrep, ast-grep) for " +
      "already-indexed files. Requires --force. Daemon-aware: hits the running daemon when one is up.",
  )
  .option("--all", "Rebuild every project.", false)
  .option("--force", "Skip confirmation.", false)
  .action(async (path: string | undefined, opts: { all: boolean; force: boolean }) => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const resolved = opts.all ? null : resolveCommandPath(path);
    if (!opts.all && resolved === null) {
      const start = path === undefined || path === "." ? process.cwd() : resolve(path);
      console.error(
        `[loctx rebuild] no project marker found at or above ${start}. Pass --all to rebuild every project.`,
      );
      process.exit(1);
    }
    if (!opts.force) {
      const target = opts.all
        ? "EVERY project"
        : `${resolved?.name ?? ""} at ${resolved?.root ?? ""}`;
      console.error(
        `[loctx rebuild] refusing without --force.\n  This deletes every chunk + vector row for ${target}\n  and re-indexes from scratch. Source files are untouched.`,
      );
      process.exit(1);
    }
    const lock = readActiveDaemon(config.paths.dataDir);
    if (lock !== null) {
      const client = daemonClient(config.paths.dataDir);
      const r = await client.post<{ summaries: Array<{ name: string; indexed: number }> }>(
        "/api/rebuild",
        resolved !== null ? { path: resolved.root } : {},
      );
      for (const s of r.summaries) {
        console.log(`rebuilt ${s.name}: indexed=${s.indexed}`);
      }
      return;
    }
    // No-daemon fallback: same purge-then-index sequence the daemon endpoint runs.
    const runtime = await buildRuntime(config);
    try {
      const projects = resolved !== null ? [resolved] : runtime.discovery.discoverProjects();
      for (const project of projects) {
        console.log(`Rebuilding ${project.name} (${project.root}) ...`);
        // Persist rebuild intent before the destructive purge — a crash
        // here leaves a marker the next `loctx start` will pick up and
        // resume with priority. Keeps the project row alive so the
        // marker survives.
        runtime.state.upsertProjectWithActive(project, true);
        runtime.state.markProjectRebuildPending(project.id);
        await runtime.vectors.deleteProjectChunks(project.id);
        runtime.state.purgeProjectContents(project.id);
        const summary = await runtime.indexer.indexProject(project);
        // Rebuild is a strict superset of a reconcile pass — stamp
        // last_reconciled_at so doctor + the projects page don't show
        // a stale "reconciled —" right after.
        runtime.state.markProjectReconciled(project.id);
        runtime.state.clearProjectRebuildPending(project.id);
        console.log(
          `  indexed=${summary.indexed} skipped=${summary.skipped} failed=${summary.failed} (${summary.elapsedSeconds.toFixed(2)}s)`,
        );
      }
    } finally {
      await runtime.close();
    }
  });

program
  .command("purge [path]")
  .description(
    "Delete the index data for a project (LanceDB + SQLite rows). " +
      "PATH may be omitted or `.` to use the project containing cwd. " +
      "Source files untouched. Hits the running daemon when one is up; otherwise builds a one-shot runtime.",
  )
  .option("--force", "Skip confirmation.", false)
  .action(async (path: string | undefined, opts: { force: boolean }) => {
    const project = resolveCommandPath(path);
    if (project === null) {
      const start = path === undefined || path === "." ? process.cwd() : resolve(path);
      console.error(`[loctx purge] no project marker found at or above ${start}.`);
      process.exit(1);
    }
    if (!opts.force) {
      console.error(
        `[loctx purge] refusing without --force.\n  This deletes every chunk + vector row for ${project.name} at\n  ${project.root}. Source files are untouched.`,
      );
      process.exit(1);
    }
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const lock = readActiveDaemon(config.paths.dataDir);
    if (lock !== null) {
      const client = daemonClient(config.paths.dataDir);
      const r = await client.post<{ project: { name: string; root: string } }>(
        "/api/reset/project",
        { path: project.root },
      );
      console.error(`[loctx purge] cleared ${r.project.name} (${r.project.root}) via daemon.`);
      return;
    }
    // No-daemon fallback: drop the project's vectors + state in-process.
    const runtime = await buildRuntime(config);
    try {
      await runtime.vectors.deleteProjectChunks(project.id);
      runtime.state.deleteProject(project.id);
      console.error(`[loctx purge] cleared ${project.name} (${project.root}).`);
    } finally {
      await runtime.close();
    }
  });

/**
 * Translate daemon/HTTP errors to clean one-liners. Returns true when
 * the error was handled (and process.exit was called); returns false
 * when the caller should fall through to its own handling. Centralises
 * the pretty-printing so the global parseAsync catch and the explicit
 * withDaemonClient wrapper both share one rule set.
 */
function handleDaemonError(err: unknown): boolean {
  if (err instanceof NoDaemonError) {
    console.error("No active daemon. Start one with `loctx start`.");
    process.exit(1);
  }
  if (err instanceof DaemonHttpError) {
    const body = err.body.trim();
    console.error(`[loctx] daemon ${err.status}: ${body === "" ? "(empty body)" : body}`);
    process.exit(1);
  }
  // fetch() throws a TypeError with cause.code === "ECONNREFUSED" when
  // the daemon's TCP listener dies between lockfile read and request.
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === "ECONNREFUSED") {
    console.error(
      "[loctx] daemon lockfile exists but the HTTP listener is unreachable. " +
        "The daemon may have crashed — try `loctx stop` then `loctx start`.",
    );
    process.exit(1);
  }
  return false;
}

async function withDaemonClient(
  fn: (client: ReturnType<typeof daemonClient>) => Promise<void>,
): Promise<void> {
  const ctx = getCtx();
  const config = loadConfigOrFail(ctx);
  try {
    const client = daemonClient(config.paths.dataDir);
    await fn(client);
  } catch (err) {
    handleDaemonError(err);
    throw err;
  }
}

/**
 * Resolve a path/--all pair to a list of target projects for the
 * pause/resume verbs. With `--all`, asks the daemon for every active
 * watcher. Otherwise walks up from `path` (or cwd) and errors if no
 * project marker is found.
 */
async function resolveScopedTargets(
  client: ReturnType<typeof daemonClient>,
  path: string | undefined,
  all: boolean,
  verb: string,
): Promise<Array<{ id: string; name: string }>> {
  if (all) {
    const list = await client.get<{ entries: Array<{ projectId: string; projectName: string }> }>(
      "/api/watchers",
    );
    return list.entries.map((e) => ({ id: e.projectId, name: e.projectName }));
  }
  const project = resolveCommandPath(path);
  if (project === null) {
    const start = path === undefined || path === "." ? process.cwd() : resolve(path);
    console.error(
      `[loctx ${verb}] no project marker found at or above ${start}. Pass --all to ${verb} every project.`,
    );
    process.exit(1);
  }
  return [{ id: project.id, name: project.name }];
}

// ---- init (interactive first-run wizard) -------------------------------

program
  .command("init")
  .description(
    "Interactive first-run setup: pick workspace roots, use case, embedding model, and daemon port. Writes a sensible config.",
  )
  .option("--force", "Overwrite an existing config file.", false)
  .action(async (opts: { force: boolean }) => {
    const { runInitWizard } = await import("./wizard.js");
    const ctx = getCtx();
    try {
      await runInitWizard({ target: ctx.configPath, force: opts.force });
    } catch (err) {
      console.error(`[loctx init] ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---- config -------------------------------------------------------------

const configCmd = program
  .command("config")
  .description("Inspect or scaffold the loctx config files. Requires a subcommand.");

configCmd
  .command("show")
  .description("Print the effective merged config with the source of each value.")
  .action(() => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    printConfig(config);
  });

configCmd
  .command("init")
  .description(
    "Write a commented config template to $XDG_CONFIG_HOME/loctx/config.yaml. Never overwrites.",
  )
  .option("--force", "Overwrite an existing file.", false)
  .action(async (opts: { force: boolean }) => {
    const { existsSync, writeFileSync } = await import("node:fs");
    const { CONFIG_TEMPLATE } = await import("@loctx/core");
    const ctx = getCtx();
    const target = ctx.configPath;
    if (existsSync(target) && !opts.force) {
      console.error(
        `[loctx config init] refused: ${target} already exists. Pass --force to overwrite.`,
      );
      process.exit(1);
    }
    writeFileSync(target, CONFIG_TEMPLATE, "utf-8");
    console.error(`[loctx config init] wrote ${target}`);
  });

configCmd.action(() => {
  console.log("loctx config: specify a subcommand (e.g. 'show' or 'init').");
  console.log("Use --help for options.");
});

// ---- model --------------------------------------------------------------

const modelCmd = program
  .command("model")
  .description("Manage the embedding model used for indexing. Requires a subcommand.");

modelCmd
  .command("list")
  .description("Show available embedding models with size, dimension, and use case.")
  .action(async () => {
    const { EMBEDDING_REGISTRY } = await import("@loctx/core");
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const current = config.embedding.model;
    console.log("Available embedding models:");
    for (const m of EMBEDDING_REGISTRY) {
      const marker = m.name === current ? "*" : " ";
      console.log(
        `  ${marker} ${m.name.padEnd(46)} ${String(m.sizeMB).padStart(4)} MB  dim=${String(m.dimension).padStart(4)}  [${m.useCase}]`,
      );
      console.log(`      ${m.description}`);
    }
    console.log("");
    console.log("* = active. Run 'loctx model use <name>' to switch.");
  });

modelCmd
  .command("current")
  .description("Print the active embedding model.")
  .action(() => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    console.log(config.embedding.model);
  });

modelCmd
  .command("use <name>")
  .description(
    "Switch the active embedding model. Reindex required afterward. " +
      "Prompts for confirmation unless --yes — switching invalidates the existing " +
      "index and forces a full re-embed pass on every project.",
  )
  .option("-y, --yes", "Skip the confirmation prompt.", false)
  .action(async (name: string, opts: { yes: boolean }) => {
    const { findModel } = await import("@loctx/core");
    const info = findModel(name);
    if (info === null) {
      console.error(`Unknown model '${name}'. Run 'loctx model list' to see available options.`);
      process.exit(1);
    }
    // Mirror the /models web confirm (#315). A model switch silently
    // invalidates the existing index: LanceDB throws
    // CollectionIdentityMismatch on next daemon start, and the user
    // is forced into `loctx reset index --force` + hours of re-embed.
    if (!opts.yes) {
      const ok = await confirm(
        `Switch embedding.model to ${info.name}? Existing index will mismatch on next daemon start (CollectionIdentityMismatch) — recovery is \`loctx reset index --force\` + re-index every project, which can take minutes to hours.`,
      );
      if (!ok) {
        console.error("[loctx model use] cancelled.");
        process.exit(1);
      }
    }
    await writeModelChoice(info.name, info.normalize);
    console.error(`[loctx model use] switched embedding.model to ${info.name}.`);
    console.error("[loctx model use] the existing index was built for the previous model;");
    console.error("                  run 'loctx reset index' then 'loctx index' to rebuild it,");
    console.error("                  or expect a CollectionIdentityMismatch on next start.");
    // A running daemon keeps the old model in memory until it restarts.
    // Without this warning, the user assumes the swap took effect, hits
    // the daemon, and gets stale-model results until they happen to
    // restart. Mirrors the /admin disable-reset-while-running posture.
    if (readActiveDaemon(loadConfigOrFail(getCtx()).paths.dataDir) !== null) {
      console.error(
        "[loctx model use] note: a daemon is running and still holds the old model. " +
          "Run 'loctx restart' after the reset+reindex to apply.",
      );
    }
  });

modelCmd
  .command("download <name>")
  .description("Pre-download a model into the Hugging Face cache. Useful offline prep.")
  .option(
    "--use",
    "Also set this model as the active one in embedding.model (global config).",
    false,
  )
  .action(async (name: string, opts: { use: boolean }) => {
    const { findModel, LocalEmbeddingProvider, markModelTrusted, setAllowedOutboundReasons } =
      await import("@loctx/core");
    const info = findModel(name);
    if (info === null) {
      console.error(`Unknown model '${name}'. Run 'loctx model list' to see options.`);
      process.exit(1);
    }
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    // Explicit user opt-in for an outbound fetch. Other commands keep
    // the default (blocked) behaviour from #43.
    setAllowedOutboundReasons(["model-download"]);
    console.error(`[loctx model download] fetching ${info.name} (~${info.sizeMB} MB)...`);
    const provider = new LocalEmbeddingProvider({
      modelName: info.name,
      normalize: info.normalize,
      dataDir: config.paths.dataDir,
    });
    await provider.ensureReady();
    // Persist the consent so subsequent commands (daemon, index, search)
    // can load this model without flipping the in-process allow flag.
    markModelTrusted(config.paths.dataDir, info.name);
    console.error("[loctx model download] done.");
    if (opts.use) {
      const previous = config.embedding.model;
      await writeModelChoice(info.name, info.normalize);
      console.error(`[loctx model download] embedding.model: ${previous} → ${info.name}`);
      console.error("[loctx model download] the existing index was built for the previous model;");
      console.error(
        "                       run 'loctx reset index --force' then 'loctx index' to rebuild it.",
      );
    } else if (info.name !== config.embedding.model) {
      console.error(
        `[loctx model download] note: active model is still ${config.embedding.model}. ` +
          `Run 'loctx model use ${info.name}' (or rerun with --use) to switch.`,
      );
    }
  });

modelCmd.action(() => {
  console.log("loctx model: specify a subcommand (list, current, use, download).");
  console.log("Use --help for options.");
});

async function writeModelChoice(modelName: string, normalize: boolean): Promise<void> {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");
  const ctx = getCtx();
  const target = ctx.configPath;

  type Mutable = Record<string, unknown> & { embedding?: Record<string, unknown> };
  const existing: Mutable = existsSync(target)
    ? ((parseYaml(readFileSync(target, "utf-8"), {
        merge: false,
        maxAliasCount: 100,
      }) as Mutable | null) ?? {})
    : {};

  const embedding: Record<string, unknown> = { ...(existing.embedding ?? {}) };
  embedding["model"] = modelName;
  embedding["normalize"] = normalize;
  existing.embedding = embedding;

  writeFileSync(target, stringifyYaml(existing), "utf-8");
}

// ---- serve / doctor stubs ----------------------------------------------

program
  .command("serve")
  .description("Start the MCP stdio server (use `loctx start` for the integrated daemon).")
  .action(() =>
    unimplemented("serve", "— use `loctx-mcp` (stdio) or `loctx start` (HTTP at /mcp) instead"),
  );
program
  .command("doctor")
  .description("Check configuration, storage, daemon, schema, and discovery health.")
  .action(async () => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const checks = await runDoctorChecks(config);
    for (const c of checks) {
      const tag = c.status === "ok" ? "[ ok ]" : c.status === "warn" ? "[warn]" : "[err ]";
      console.log(`${tag} ${c.name.padEnd(22)} ${c.detail}`);
    }
    const worst = worstStatus(checks);
    console.log("");
    console.log(`summary: ${worst}`);
    if (worst === "error") process.exit(1);
  });

// ---- status -------------------------------------------------------------

program
  .command("status")
  .description("Report configured workspace, storage, and index state.")
  .action(async () => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const state = new StateStore(config.paths.stateDb);
    let inventory: ReturnType<typeof inventoryProjects>;
    let pendingRebuilds: ReadonlyArray<{ id: string; rebuildPendingAt: string }>;
    try {
      inventory = inventoryProjects(discovery, state);
      pendingRebuilds = state.listProjectsWithRebuildPending();
    } finally {
      state.close();
    }

    const daemon = readActiveDaemon(config.paths.dataDir);
    const daemonRow: string = daemon
      ? `running (PID ${daemon.pid}${daemon.port ? `, http://${daemon.hostname ?? "localhost"}:${daemon.port}` : ""}, started ${daemon.startedAt})`
      : "not running";

    // When the daemon is up, fetch its live reconciliation state so the
    // CLI tells the user when results may be partial (#46 / mirrors the
    // admin UI's reconcile banner and the MCP indexHealth field).
    let reconcileLine: string | null = null;
    if (daemon !== null) {
      try {
        const client = daemonClient(config.paths.dataDir);
        const status = await client.get<{
          reconciliation?: {
            running: boolean;
            currentProjectName: string | null;
            completed: number;
            total: number;
            currentProjectIndexed: number | null;
            currentProjectTotal: number | null;
          };
        }>("/api/status");
        const r = status.reconciliation;
        if (r?.running) {
          const fileLabel =
            r.currentProjectIndexed !== null && r.currentProjectTotal !== null
              ? `, ${r.currentProjectIndexed}/${r.currentProjectTotal} files`
              : "";
          reconcileLine = `reconciling — project ${r.completed + 1}/${r.total}: ${r.currentProjectName ?? "?"}${fileLabel}`;
        }
      } catch {
        // Daemon up but unreachable on /api/status; skip the live row.
      }
    }

    console.log("loctx status:");
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["config", config.source ?? `${ctx.configPath} (default)`],
      ["daemon", daemonRow],
      ...(reconcileLine !== null ? ([["reconcile", reconcileLine]] as const) : []),
      ["data dir", config.paths.dataDir],
      ["vector dir", config.paths.vectorDir],
      ["state db", config.paths.stateDb],
      ["logs dir", config.paths.logsDir],
      ["embedding", `${config.embedding.provider}/${config.embedding.model}`],
    ];
    for (const [label, value] of rows) {
      console.log(`  ${label.padEnd(14)}: ${value}`);
    }
    console.log("  workspace roots:");
    for (const root of config.workspaceRoots) {
      console.log(`    - ${root}`);
    }
    const pendingSet = new Set(pendingRebuilds.map((p) => p.id as string));
    console.log(`  active projects (${inventory.active.length}):`);
    for (const { project, lastIndexedAt, marker, markerKind } of inventory.active) {
      const stamp = lastIndexedAt ? `  (indexed ${lastIndexedAt})` : "";
      const tag = `[${marker}${markerKind !== "git" ? `:${markerKind}` : ""}]`;
      const pending = pendingSet.has(project.id) ? "  ⚠ rebuild_pending" : "";
      console.log(`    ${project.id}  ${project.name}  ${project.root}  ${tag}${stamp}${pending}`);
    }
    if (inventory.orphaned.length > 0) {
      console.log(`  orphaned projects (${inventory.orphaned.length}, still queryable):`);
      for (const { project, reason, rootExists } of inventory.orphaned) {
        const tag = rootExists ? `[${reason}]` : "[missing]";
        console.log(`    ${project.id}  ${project.name}  ${project.root}  ${tag}`);
      }
    }
  });

// ---- reset --------------------------------------------------------------

const reset = program.command("reset").description("Reset local state. Requires a subcommand.");

reset
  .command("index")
  .description(
    "Delete ALL local LanceDB + SQLite state for the configured data dir. " +
      "Requires --force; refuses while a daemon is running.",
  )
  .option("--force", "Skip confirmation.", false)
  .action(async (opts: { force: boolean }) => {
    if (!opts.force) {
      console.error(
        "[loctx reset index] refusing without --force.\n" +
          "  This deletes every chunk, vector, and file row for the configured\n" +
          "  data dir. Source files are untouched. Pass --force to proceed.",
      );
      process.exit(1);
    }
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);

    const lock = readActiveDaemon(config.paths.dataDir);
    if (lock !== null) {
      console.error(
        `[loctx reset index] daemon is running (PID ${lock.pid}). Stop it first with 'loctx stop'.`,
      );
      process.exit(1);
    }

    const { rmSync } = await import("node:fs");
    rmSync(config.paths.vectorDir, { recursive: true, force: true });
    rmSync(config.paths.stateDb, { force: true });
    rmSync(`${config.paths.stateDb}-wal`, { force: true });
    rmSync(`${config.paths.stateDb}-shm`, { force: true });
    console.error(
      `[loctx reset index] cleared ${config.paths.vectorDir} and ${config.paths.stateDb}.`,
    );
    console.error("[loctx reset index] run 'loctx index' to rebuild.");
  });

reset.action(() => {
  console.log("loctx reset: specify a subcommand (e.g. 'index').");
  console.log("For per-project cleanup, use `loctx purge`. To wipe and re-index a project,");
  console.log("use `loctx rebuild`. No destructive default. Use --help for options.");
});

// ---- run ----------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  // Try the shared daemon-error printer first so an unhandled
  // DaemonHttpError from any verb (rebuild, refresh, search…) gets the
  // same one-liner as withDaemonClient-wrapped commands.
  handleDaemonError(err);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
