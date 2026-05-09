#!/usr/bin/env node
/**
 * Commander CLI entry points for loctx.
 */

import { resolve } from "node:path";
import {
  type Config,
  ConfigError,
  DaemonLockHeldError,
  SearcherError,
  StateStore,
  WatcherService,
  WorkspaceDiscovery,
  buildRuntime,
  defaultConfigFile,
  inventoryProjects,
  loadConfig,
  makeProject,
  readActiveDaemon,
  stopActiveDaemon,
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

// ---- index --------------------------------------------------------------

program
  .command("index [path]")
  .description("Index a project (or all configured workspace roots if PATH is omitted).")
  .action(async (path?: string) => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const runtime = await buildRuntime(config);
    try {
      const projects =
        path !== undefined ? [makeProject(resolve(path))] : runtime.discovery.discoverProjects();
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
  .action(
    async (
      query: string,
      opts: {
        path?: string;
        all: boolean;
        limit: number;
        language?: string;
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
  console.log(`  project file          : ${config.projectSource ?? "(none)"}`);
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
    "Write a commented config template to $XDG_CONFIG_HOME/loctx/config.yaml " +
      "(or to a project-level .loctx.yaml with --project). Never overwrites.",
  )
  .option("--project", "Write to ./.loctx.yaml in the current directory instead.", false)
  .option("--force", "Overwrite an existing file.", false)
  .action(async (opts: { project: boolean; force: boolean }) => {
    const { existsSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { CONFIG_TEMPLATE } = await import("@loctx/core");
    const ctx = getCtx();
    const target = opts.project ? resolve(".loctx.yaml") : ctx.configPath;
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
  .option("--project", "Write to ./.loctx.yaml in the current directory instead.", false)
  .action(async (name: string, opts: { project: boolean }) => {
    const { findModel } = await import("@loctx/core");
    const info = findModel(name);
    if (info === null) {
      console.error(`Unknown model '${name}'. Run 'loctx model list' to see available options.`);
      process.exit(1);
    }
    await writeModelChoice(opts.project, info.name, info.normalize);
    console.error(`[loctx model use] switched embedding.model to ${info.name}.`);
    console.error("[loctx model use] the existing index was built for the previous model;");
    console.error("                  run 'loctx reset index' then 'loctx index' to rebuild it,");
    console.error("                  or expect a CollectionIdentityMismatch on next start.");
  });

modelCmd
  .command("download <name>")
  .description("Pre-download a model into the Hugging Face cache. Useful offline prep.")
  .action(async (name: string) => {
    const { findModel, LocalEmbeddingProvider } = await import("@loctx/core");
    const info = findModel(name);
    if (info === null) {
      console.error(`Unknown model '${name}'. Run 'loctx model list' to see options.`);
      process.exit(1);
    }
    console.error(`[loctx model download] fetching ${info.name} (~${info.sizeMB} MB)...`);
    const provider = new LocalEmbeddingProvider({
      modelName: info.name,
      normalize: info.normalize,
    });
    await provider.ensureReady();
    console.error("[loctx model download] done.");
  });

modelCmd.action(() => {
  console.log("loctx model: specify a subcommand (list, current, use, download).");
  console.log("Use --help for options.");
});

async function writeModelChoice(
  isProject: boolean,
  modelName: string,
  normalize: boolean,
): Promise<void> {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");
  const ctx = getCtx();
  const target = isProject ? resolve(".loctx.yaml") : ctx.configPath;

  type Mutable = Record<string, unknown> & { embedding?: Record<string, unknown> };
  const existing: Mutable = existsSync(target)
    ? ((parseYaml(readFileSync(target, "utf-8")) as Mutable | null) ?? {})
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

    let worst: "ok" | "warn" | "error" = "ok";
    for (const c of checks) {
      const tag = c.status === "ok" ? "[ ok ]" : c.status === "warn" ? "[warn]" : "[err ]";
      console.log(`${tag} ${c.name.padEnd(22)} ${c.detail}`);
      if (c.status === "error") worst = "error";
      else if (c.status === "warn" && worst !== "error") worst = "warn";
    }
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
    for (const { project, lastIndexedAt } of inventory.active) {
      const stamp = lastIndexedAt ? `  (indexed ${lastIndexedAt})` : "";
      console.log(`    ${project.id}  ${project.name}  ${project.root}${stamp}`);
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
  .description("Delete the entire local LanceDB + SQLite state.")
  .option("--force", "Skip confirmation.", false)
  .action(() => unimplemented("reset index"));
reset
  .command("project <path>")
  .description("Delete index entries for a single project.")
  .option("--force", "Skip confirmation.", false)
  .action((path: string) => unimplemented("reset project", `(${path})`));
reset.action(() => {
  console.log("loctx reset: specify a subcommand (e.g. 'index' or 'project').");
  console.log("No destructive default. Use --help for options.");
});

// ---- doctor checks ------------------------------------------------------

interface DoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "error";
  readonly detail: string;
}

async function runDoctorChecks(config: Config): Promise<DoctorCheck[]> {
  const { existsSync, statSync } = await import("node:fs");
  const checks: DoctorCheck[] = [];

  // Config presence + source.
  checks.push({
    name: "config",
    status: "ok",
    detail: `loaded from ${config.source ?? "(defaults)"}; project=${config.projectSource ?? "(none)"}`,
  });

  // Storage paths.
  for (const [label, p] of [
    ["dataDir", config.paths.dataDir],
    ["configDir", config.paths.configDir],
    ["vectorDir", config.paths.vectorDir],
    ["logsDir", config.paths.logsDir],
  ] as const) {
    if (!existsSync(p)) {
      checks.push({
        name: `path:${label}`,
        status: "warn",
        detail: `${p} (will be created on first use)`,
      });
      continue;
    }
    try {
      const st = statSync(p);
      checks.push({
        name: `path:${label}`,
        status: st.isDirectory() ? "ok" : "error",
        detail: st.isDirectory() ? p : `${p} exists but is not a directory`,
      });
    } catch (err) {
      checks.push({
        name: `path:${label}`,
        status: "error",
        detail: `${p}: ${(err as Error).message}`,
      });
    }
  }

  // Daemon lock state.
  const lock = readActiveDaemon(config.paths.dataDir);
  checks.push(
    lock !== null
      ? {
          name: "daemon",
          status: "ok",
          detail: `running PID ${lock.pid} on ${lock.hostname}:${lock.port}; started ${lock.startedAt}`,
        }
      : {
          name: "daemon",
          status: "warn",
          detail: "not running (loctx start to launch)",
        },
  );

  // Schema + project counts (open the state DB read-only-ish).
  if (existsSync(config.paths.stateDb)) {
    try {
      const state = new StateStore(config.paths.stateDb);
      try {
        const projects = state.listProjects();
        checks.push({
          name: "state.sqlite3",
          status: "ok",
          detail: `${projects.length} project rows, schema healthy`,
        });
        let totalErrors = 0;
        for (const p of projects) {
          const errs = state.listFiles(p.id).filter((f) => f.error !== null).length;
          totalErrors += errs;
        }
        if (totalErrors > 0) {
          checks.push({
            name: "index errors",
            status: "warn",
            detail: `${totalErrors} files indexed with errors (run 'loctx index' to retry)`,
          });
        } else {
          checks.push({ name: "index errors", status: "ok", detail: "none" });
        }
      } finally {
        state.close();
      }
    } catch (err) {
      checks.push({
        name: "state.sqlite3",
        status: "error",
        detail: (err as Error).message,
      });
    }
  } else {
    checks.push({
      name: "state.sqlite3",
      status: "warn",
      detail: `${config.paths.stateDb} doesn't exist yet; run 'loctx index' to create it`,
    });
  }

  // Project discovery.
  try {
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const projects = discovery.discoverProjects();
    checks.push({
      name: "discovery",
      status: projects.length > 0 ? "ok" : "warn",
      detail:
        projects.length > 0
          ? `${projects.length} projects under ${config.workspaceRoots.join(", ")}`
          : `no .git-marked projects under ${config.workspaceRoots.join(", ")}`,
    });
  } catch (err) {
    checks.push({
      name: "discovery",
      status: "error",
      detail: (err as Error).message,
    });
  }

  // Embedding model identity.
  checks.push({
    name: "embedding",
    status: "ok",
    detail: `${config.embedding.provider}/${config.embedding.model} normalize=${config.embedding.normalize}${
      config.embedding.providerOverride ? ` override=${config.embedding.providerOverride}` : ""
    }`,
  });

  // Retrieval mode.
  checks.push({
    name: "retrieval",
    status: "ok",
    detail: `mode=${config.retrieval.mode} rrfK=${config.retrieval.rrfK}`,
  });

  return checks;
}

// ---- run ----------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
