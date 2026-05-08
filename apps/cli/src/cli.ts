#!/usr/bin/env node
/**
 * Commander CLI entry points for loctx.
 */

import { resolve } from "node:path";
import {
  type Config,
  ConfigError,
  type Scope,
  SearcherError,
  WatcherService,
  WorkspaceDiscovery,
  buildRuntime,
  defaultConfigFile,
  loadConfig,
  makeProject,
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
      runtime.close();
    }
  });

// ---- search -------------------------------------------------------------

program
  .command("search <query>")
  .description("Search the indexed workspace.")
  .option("--cwd <path>", "Override working directory used for scope resolution.")
  .option("--scope <scope>", "auto | project | subtree | all", "auto")
  .option(
    "--mode <mode>",
    "hybrid | semantic | keyword | path | symbol (only 'semantic' wired today)",
    "semantic",
  )
  .option("--limit <n>", "Maximum results", (v) => Number.parseInt(v, 10), 10)
  .option("--language <lang>", "Filter results to a single language.")
  .action(
    async (
      query: string,
      opts: {
        cwd?: string;
        scope: string;
        mode: string;
        limit: number;
        language?: string;
      },
    ) => {
      if (opts.mode !== "semantic") {
        console.error(`# --mode ${opts.mode} not yet implemented; running semantic search.`);
      }
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);
      const runtime = await buildRuntime(config);
      try {
        const response = await runtime.searcher.search({
          query,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          scope: opts.scope as Scope,
          limit: opts.limit,
          ...(opts.language !== undefined ? { language: opts.language } : {}),
        });

        let scopeLabel: string = response.resolvedScope.mode;
        if (response.resolvedScope.project) {
          scopeLabel = `${scopeLabel}(${response.resolvedScope.project.name})`;
        }
        if (response.resolvedScope.relPrefix) {
          scopeLabel = `${scopeLabel}#${response.resolvedScope.relPrefix}`;
        }
        console.log(`# scope: ${scopeLabel}  results: ${response.results.length}`);
        for (const warning of response.warnings) {
          console.error(`# warning: ${warning}`);
        }

        for (const result of response.results) {
          let header = `${result.score.toFixed(3)}  ${result.relPath}:${result.startLine}-${result.endLine}  [${result.kind}]`;
          if (result.symbols.length > 0) header += `  ${result.symbols.join(", ")}`;
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
        runtime.close();
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

// ---- start --------------------------------------------------------------

program
  .command("start")
  .description("Run the integrated daemon: watcher + Next.js admin UI + MCP at /mcp on one port.")
  .option(
    "-p, --port <n>",
    "HTTP port for the admin UI + MCP endpoint.",
    (v) => Number.parseInt(v, 10),
    3000,
  )
  .option("--hostname <host>", "Bind hostname.", "localhost")
  .option("--no-watch", "Skip the filesystem watcher.")
  .option("--no-web", "Skip the Next.js admin UI / MCP HTTP transport.")
  .action(async (opts: { port: number; hostname: string; watch: boolean; web: boolean }) => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const { start: runStart } = await import("./start.js");
    await runStart(config, {
      port: opts.port,
      hostname: opts.hostname,
      enableWatch: opts.watch,
      enableWeb: opts.web,
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

      const watchers: WatcherService[] = [];
      for (const project of projects) {
        const w = new WatcherService(project, runtime.indexer, {
          onEvent: (event, relPath) => console.log(`${event}\t${project.name}/${relPath}`),
        });
        await w.start();
        watchers.push(w);
      }
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
      runtime.close();
    }
  });

// ---- serve / doctor stubs ----------------------------------------------

program
  .command("serve")
  .description("Start the MCP stdio server (use `loctx start` for the integrated daemon).")
  .action(() =>
    unimplemented("serve", "— use `loctx-mcp` (stdio) or `loctx start` (HTTP at /mcp) instead"),
  );
program
  .command("doctor")
  .description("Check configuration, storage, and embedding readiness.")
  .action(() => unimplemented("doctor"));

// ---- status -------------------------------------------------------------

program
  .command("status")
  .description("Report configured workspace, storage, and index state.")
  .action(() => {
    const ctx = getCtx();
    const config = loadConfigOrFail(ctx);
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const projects = discovery.discoverProjects();

    console.log("loctx status:");
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["config", config.source ?? `${ctx.configPath} (default)`],
      ["data dir", config.paths.dataDir],
      ["chroma dir", config.paths.chromaDir],
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
    console.log(`  discovered projects (${projects.length}):`);
    for (const project of projects) {
      console.log(`    ${project.id}  ${project.name}  ${project.root}`);
    }
  });

// ---- reset --------------------------------------------------------------

const reset = program.command("reset").description("Reset local state. Requires a subcommand.");
reset
  .command("index")
  .description("Delete the entire local Chroma + SQLite state.")
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

// ---- run ----------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
