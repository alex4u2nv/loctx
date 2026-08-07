/**
 * `init` (first-run wizard) and `setup-agent` (coding-agent wiring).
 */

import { resolve } from "node:path";
import { AGENTS, loadConfig } from "@loctx/core";
import type { Command } from "commander";
import { runAgentRefresh, runAgentSetup } from "../lib/agent-setup.js";
import { EXIT, errorMessage, getCtx } from "../lib/context.js";

export function registerAgentCommands(program: Command): void {
  program
    .command("init")
    .description(
      "Interactive first-run setup: pick workspace roots, use case, embedding model, and daemon port. Writes a sensible config.",
    )
    .option("--force", "Overwrite an existing config file.", false)
    .action(async (opts: { force: boolean }) => {
      const { runInitWizard } = await import("../wizard.js");
      const ctx = getCtx();
      try {
        await runInitWizard({ target: ctx.configPath, force: opts.force });
      } catch (err) {
        console.error(`[loctx init] ${errorMessage(err)}`);
        process.exit(EXIT.error);
      }
    });

  program
    .command("setup-agent [agents...]")
    .description(
      `Write MCP registration + usage rules so coding agents use loctx (${AGENTS.map((a) => a.id).join(", ")}). ` +
        "With no agents named, targets the ones detected in this project. Non-destructive: merges JSON, updates only loctx-marked blocks.",
    )
    .option("--path <dir>", "Project root to write project-scoped config into. Defaults to cwd.")
    .option(
      "--http",
      "Register the HTTP transport (talks to a running daemon) instead of spawning loctx-mcp.",
      false,
    )
    .option("--dry-run", "Show what would change without writing.", false)
    .option(
      "--refresh",
      "Re-stamp every already-wired project under workspace_roots with the latest rules/skill. Doesn't wire new projects.",
      false,
    )
    .option("-y, --yes", "Skip the confirmation prompt.", false)
    .action(
      async (
        agentsArg: string[],
        opts: { path?: string; http: boolean; dryRun: boolean; refresh: boolean; yes: boolean },
      ) => {
        let port: number | undefined;
        if (opts.http) {
          try {
            port = loadConfig(getCtx().configPath).daemon.port;
          } catch {
            console.error("[setup-agent] --http needs a readable config for the daemon port.");
            process.exitCode = EXIT.error;
            return;
          }
        }
        if (opts.refresh) {
          await runAgentRefresh({
            transport: opts.http ? "http" : "stdio",
            ...(port !== undefined ? { port } : {}),
          });
          return;
        }
        const projectRoot = opts.path !== undefined ? resolve(opts.path) : process.cwd();
        await runAgentSetup(projectRoot, {
          requested: agentsArg,
          transport: opts.http ? "http" : "stdio",
          ...(port !== undefined ? { port } : {}),
          dryRun: opts.dryRun,
          yes: opts.yes,
        });
      },
    );
}
