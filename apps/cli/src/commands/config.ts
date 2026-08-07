/**
 * `config` (show / init) and `reset` (index) — config inspection and
 * local-state teardown. Registered by two functions so `cli.ts` keeps
 * their original, non-adjacent slots in the command list.
 */

import { readActiveDaemon } from "@loctx/core";
import type { Command } from "commander";
import { EXIT, getCtx, loadConfigOrFail } from "../lib/context.js";
import { printConfig } from "../lib/print.js";

export function registerConfigCommands(program: Command): void {
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
        process.exit(EXIT.error);
      }
      writeFileSync(target, CONFIG_TEMPLATE, "utf-8");
      console.error(`[loctx config init] wrote ${target}`);
    });

  configCmd.action(() => {
    console.log("loctx config: specify a subcommand (e.g. 'show' or 'init').");
    console.log("Use --help for options.");
  });
}

export function registerResetCommands(program: Command): void {
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
        process.exit(EXIT.error);
      }
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);

      const lock = readActiveDaemon(config.paths.dataDir);
      if (lock !== null) {
        console.error(
          `[loctx reset index] daemon is running (PID ${lock.pid}). Stop it first with 'loctx stop'.`,
        );
        process.exit(EXIT.error);
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
}
