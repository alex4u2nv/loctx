#!/usr/bin/env node
/**
 * Commander CLI entry point for loctx. Builds the shared `program`
 * singleton, lets each command module register its verbs (in the order
 * they appear in `--help`), then parses. Command logic lives under
 * `commands/`; shared helpers under `lib/`.
 */

import { readPackageVersion } from "@loctx/core";
import { registerAgentCommands } from "./commands/agent.js";
import { registerConfigCommands, registerResetCommands } from "./commands/config.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerIndexingCommands } from "./commands/indexing.js";
import { registerModelCommands } from "./commands/model.js";
import { registerProjectActivation, registerProjectMaintenance } from "./commands/project.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerSystemCommands } from "./commands/system.js";
import { registerToolsCommands } from "./commands/tools.js";
import { program } from "./lib/context.js";
import { handleDaemonError } from "./lib/daemon-io.js";

// Real package version (#451) — resolves from src/ (tsx dev) and dist/
// alike; both sit one level below apps/cli/package.json.
const VERSION = readPackageVersion(new URL("../package.json", import.meta.url));

program
  .name("loctx")
  .description("Local-first code indexing and search for MCP-capable agents.")
  .version(VERSION, "-V, --version")
  .option(
    "-c, --config <path>",
    "Path to a loctx config YAML. Defaults to $XDG_CONFIG_HOME/loctx/config.yaml.",
  )
  .option("--debug", "Enable verbose logging.", false);

// Registration order is the `--help` command order — keep it stable.
registerIndexingCommands(program); // index, refresh
registerProjectActivation(program); // add, activate, deactivate
registerSearchCommands(program); // search, find-usages
registerDaemonCommands(program); // start, stop, restart
registerToolsCommands(program); // update, install-tools, watch
registerProjectMaintenance(program); // pause, resume, rebuild, purge
registerAgentCommands(program); // init, setup-agent
registerConfigCommands(program); // config
registerModelCommands(program); // model
registerSystemCommands(program); // serve, doctor, status
registerResetCommands(program); // reset

program.parseAsync(process.argv).catch((err: unknown) => {
  // Try the shared daemon-error printer first so an unhandled
  // DaemonHttpError from any verb (rebuild, refresh, search…) gets the
  // same one-liner as withDaemonClient-wrapped commands.
  handleDaemonError(err);
  // Default to one-line output so unexpected errors don't drown the
  // user in a Node stack. LOCTX_LOG=debug opts into the full trace
  // for diagnosing programmer errors (TypeError, undefined-prop reads,
  // etc.) — the same env-var the daemon's debug logging respects.
  if (process.env["LOCTX_LOG"] === "debug" && err instanceof Error) {
    console.error(err.stack ?? err.message);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
