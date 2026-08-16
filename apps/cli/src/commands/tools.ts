/**
 * `update`, `install-tools`, and `watch` — release self-update, analyzer
 * tool provisioning, and the foreground watcher.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRuntime,
  daemonClient,
  installTool,
  makeProject,
  NoDaemonError,
  readActiveDaemon,
  TOOL_NAMES,
  type ToolName,
  WatcherService,
  writeConfigPatch,
} from "@loctx/core";
import type { Command } from "commander";
import { confirm, EXIT, errorMessage, getCtx, loadConfigOrFail } from "../lib/context.js";

// YAML key for a tool's `enabled`/`command` (ast-grep is camelCase in config).
const toolConfigKeys = (t: ToolName): { readonly enabled: string; readonly command: string } => {
  const section = t === "ast-grep" ? "astGrep" : t;
  return { enabled: `analyzers.${section}.enabled`, command: `analyzers.${section}.command` };
};

export function registerToolsCommands(program: Command): void {
  program
    .command("update")
    .description(
      "Update to the latest release (pre-built tarball installs) and restart the daemon.",
    )
    .action(async () => {
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);
      // A tarball install bundles install-release.sh next to the package
      // (…/versions/<v>/install-release.sh). Its presence is how we know this
      // is a release install rather than a from-source / npm-link one.
      // `..` off this module's dir climbs out of `commands/` back to `dist`,
      // reproducing cli.ts's original `dist` anchor before walking up.
      const here = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // …/versions/<v>/dist
      const installer = resolve(here, "..", "install-release.sh");
      if (!existsSync(installer)) {
        console.error(
          "loctx update applies to pre-built release installs only. You're running from source or an\n" +
            "npm link — update via that path instead (e.g. `git pull && pnpm run install:local`).",
        );
        process.exitCode = EXIT.error;
        return;
      }
      // Re-run the bundled installer (no arg → resolves the latest release for
      // this platform). Pass the proxy CA to its curl so the download works
      // behind a TLS-intercepting proxy, mirroring network.ca_cert.
      const env = { ...process.env };
      if (config.network.caCert !== null) env["LOCTX_CA_CERT"] = config.network.caCert;
      console.error("[loctx update] fetching the latest release…");
      const install = spawnSync("bash", [installer], { stdio: "inherit", env });
      if (install.status !== 0) {
        process.exitCode = install.status ?? EXIT.error;
        return;
      }
      // Restart using the freshly-installed version (the `current` symlink now
      // points at it), not this still-running old process.
      const home = resolve(here, "..", "..", "..");
      const newCli = resolve(home, "current", "dist", "cli.js");
      console.error("[loctx update] restarting daemon on the new version…");
      spawnSync(process.execPath, [newCli, "restart"], { stdio: "inherit" });
    });

  program
    .command("install-tools")
    .description(
      `Install optional analyzer tools into loctx-managed locations (${TOOL_NAMES.join(", ")}), enable them, and backfill.`,
    )
    .argument("[tools...]", "Tools to install. Defaults to lizard.")
    .option("-y, --yes", "Skip the confirmation prompt.", false)
    .action(async (toolsArg: string[], opts: { yes: boolean }) => {
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);

      const requested = toolsArg.length > 0 ? toolsArg : ["lizard"];
      const unknown = requested.filter((t) => !TOOL_NAMES.includes(t as ToolName));
      if (unknown.length > 0) {
        console.error(
          `[install-tools] unknown tool(s): ${unknown.join(", ")} (expected ${TOOL_NAMES.join(", ")})`,
        );
        process.exitCode = EXIT.error;
        return;
      }
      const tools = requested as ToolName[];

      if (!opts.yes && !(await confirm(`Install ${tools.join(", ")} via loctx?`))) return;

      // Tool installs run server-side and can take a while — semgrep pulls
      // ~60 packages and routinely exceeds the 30s default request timeout,
      // which is what made it look like "semgrep install didn't work". Raise
      // it for this command unless the user pinned their own value.
      if (!process.env["LOCTX_DAEMON_TIMEOUT_MS"]) {
        process.env["LOCTX_DAEMON_TIMEOUT_MS"] = "600000";
      }

      for (const tool of tools) {
        console.error(`[install-tools] installing ${tool}… (this can take a minute)`);
        // Prefer the running daemon: one endpoint installs, enables, hot-reloads,
        // and backfills. Fall back to a local install + config write if down.
        try {
          const r = await daemonClient(config.paths.dataDir).post<{
            ok: boolean;
            command?: string;
            backfilled?: number;
            error?: string;
            log?: string;
          }>("/api/tools/install", { tool });
          if (r.log) console.error(r.log);
          if (!r.ok) {
            console.error(`[install-tools] ${tool}: ${r.error ?? "install failed"}`);
            process.exitCode = EXIT.error;
            continue;
          }
          console.error(
            `[install-tools] ${tool} installed (${r.command}) and enabled. Backfilling ${r.backfilled ?? 0} file(s).`,
          );
        } catch (err) {
          if (!(err instanceof NoDaemonError)) {
            console.error(`[install-tools] ${tool}: ${errorMessage(err)}`);
            process.exitCode = EXIT.error;
            continue;
          }
          const result = await installTool(config, tool);
          if (result.log) console.error(result.log);
          if (!result.ok || result.command === undefined) {
            console.error(`[install-tools] ${tool}: ${result.error ?? "install failed"}`);
            process.exitCode = EXIT.error;
            continue;
          }
          const keys = toolConfigKeys(tool);
          const write = writeConfigPatch(
            config.source ?? resolve(config.paths.configDir, "config.yaml"),
            {
              "analyzers.backgroundEnabled": true,
              [keys.enabled]: true,
              [keys.command]: result.command,
            },
          );
          if (!write.ok) {
            const detail = write.errors.map((e) => `${e.key}: ${e.message}`).join("; ");
            console.error(`[install-tools] ${tool}: installed but config update failed: ${detail}`);
            process.exitCode = EXIT.error;
            continue;
          }
          console.error(
            `[install-tools] ${tool} installed (${result.command}) and enabled. Run \`loctx start\` (or restart) to backfill.`,
          );
        }
      }
    });

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
          `[loctx watch]   To see daemon activity: \`loctx status\` or http://${config.daemon.hostname}:${config.daemon.port}/.`,
        );
        process.exit(EXIT.error);
      }
      const runtime = await buildRuntime(config);
      try {
        const projects = opts.path
          ? [makeProject(resolve(opts.path))]
          : runtime.discovery.discoverProjects();
        if (projects.length === 0) {
          console.error("No projects to watch.");
          process.exit(EXIT.error);
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
}
