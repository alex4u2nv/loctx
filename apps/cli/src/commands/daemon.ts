/**
 * Daemon lifecycle: `start`, `stop`, `restart`.
 */

import { DaemonLockHeldError, stopActiveDaemon } from "@loctx/core";
import type { Command } from "commander";
import { EXIT, getCtx, loadConfigOrFail } from "../lib/context.js";

export function registerDaemonCommands(program: Command): void {
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
      const { start: runStart } = await import("../start.js");
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
          process.exit(EXIT.error);
        }
        throw err;
      }
    });

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

  program
    .command("restart")
    .description("Stop any running daemon for this data dir, then start a new one.")
    .option("--no-watch", "Skip the filesystem watcher.")
    .option("--no-web", "Skip the Next.js admin UI / MCP HTTP transport.")
    .action(async (opts: { watch: boolean; web: boolean }) => {
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);
      const { start: runStart } = await import("../start.js");
      await runStart(config, {
        enableWatch: opts.watch,
        enableWeb: opts.web,
        replace: true,
      });
    });
}
