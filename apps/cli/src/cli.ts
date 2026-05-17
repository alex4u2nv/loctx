#!/usr/bin/env node
/**
 * Commander CLI entry points for loctx.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type Config,
  ConfigError,
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
      const runtime = await buildRuntime(config);
      try {
        // CLI default: scope to whatever project contains the cwd. Pass
        // `--all` to search the whole index instead, or `--path` to point
        // at something specific.
        const path = opts.all ? undefined : (opts.path ?? process.cwd());
        const response = await runtime.searcher.search({
          query,
          ...(path !== undefined ? { path } : {}),
          limit: opts.limit,
          ...(opts.language !== undefined ? { language: opts.language } : {}),
          ...(opts.coverage ? { coverage: true } : {}),
        });

        const scopeLabel = [
          response.resolvedScope.mode,
          response.resolvedScope.project ? `(${response.resolvedScope.project.name})` : "",
          response.resolvedScope.relPrefix ? `#${response.resolvedScope.relPrefix}` : "",
        ].join("");
        console.log(`# scope: ${scopeLabel}  results: ${response.results.length}`);
        for (const warning of response.warnings) {
          console.error(`# warning: ${warning}`);
        }

        for (const result of response.results) {
          // Prefer absPath so editors and `cmd-click` resolve directly. Fall
          // back to relPath when the project's root is no longer registered.
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
    const runtime = await buildRuntime(config);
    try {
      const scopePath = opts.all ? undefined : (opts.path ?? process.cwd());
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

      const reconcile = runtime.reconciler.status();
      if (reconcile.running) {
        const fileLabel =
          reconcile.currentProjectIndexed !== null && reconcile.currentProjectTotal !== null
            ? `, ${reconcile.currentProjectIndexed}/${reconcile.currentProjectTotal} files`
            : "";
        console.error(
          `# warning: index reconciling (${reconcile.currentProjectName}${fileLabel}); results may be partial.`,
        );
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

async function withDaemonClient(
  fn: (client: ReturnType<typeof daemonClient>) => Promise<void>,
): Promise<void> {
  const ctx = getCtx();
  const config = loadConfigOrFail(ctx);
  try {
    const client = daemonClient(config.paths.dataDir);
    await fn(client);
  } catch (err) {
    if (err instanceof NoDaemonError) {
      console.error("No active daemon. Start one with `loctx start`.");
      process.exit(1);
    }
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
  .description("Switch the active embedding model. Reindex required afterward.")
  .action(async (name: string) => {
    const { findModel } = await import("@loctx/core");
    const info = findModel(name);
    if (info === null) {
      console.error(`Unknown model '${name}'. Run 'loctx model list' to see available options.`);
      process.exit(1);
    }
    await writeModelChoice(info.name, info.normalize);
    console.error(`[loctx model use] switched embedding.model to ${info.name}.`);
    console.error("[loctx model use] the existing index was built for the previous model;");
    console.error("                  run 'loctx reset index' then 'loctx index' to rebuild it,");
    console.error("                  or expect a CollectionIdentityMismatch on next start.");
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
  .action(() => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const state = new StateStore(config.paths.stateDb);
    let inventory: ReturnType<typeof inventoryProjects>;
    try {
      inventory = inventoryProjects(discovery, state);
    } finally {
      state.close();
    }

    const daemon = readActiveDaemon(config.paths.dataDir);
    const daemonRow: string = daemon
      ? `running (PID ${daemon.pid}${daemon.port ? `, http://${daemon.hostname ?? "localhost"}:${daemon.port}` : ""}, started ${daemon.startedAt})`
      : "not running";

    console.log("loctx status:");
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["config", config.source ?? `${ctx.configPath} (default)`],
      ["daemon", daemonRow],
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
    console.log(`  active projects (${inventory.active.length}):`);
    for (const { project, lastIndexedAt, marker, markerKind } of inventory.active) {
      const stamp = lastIndexedAt ? `  (indexed ${lastIndexedAt})` : "";
      const tag = `[${marker}${markerKind !== "git" ? `:${markerKind}` : ""}]`;
      console.log(`    ${project.id}  ${project.name}  ${project.root}  ${tag}${stamp}`);
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
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
