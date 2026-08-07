/**
 * `index` and `refresh` — foreground indexing and the daemon reconcile
 * trigger.
 */

import { resolve } from "node:path";
import {
  buildRuntime,
  DaemonHttpError,
  daemonClient,
  inventoryProjects,
  makeProject,
  type Project,
  readActiveDaemon,
} from "@loctx/core";
import type { Command } from "commander";
import { maybeNudgeAgentSetup } from "../lib/agent-setup.js";
import { EXIT, errorMessage, getCtx, loadConfigOrFail } from "../lib/context.js";
import { makeProgressLogger } from "../lib/daemon-io.js";

export function registerIndexingCommands(program: Command): void {
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
        process.exit(EXIT.error);
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
            process.exit(EXIT.error);
          }
        }
        if (projects.length === 0) {
          console.error("No projects found. Pass an explicit PATH or configure workspace_roots.");
          process.exit(EXIT.error);
        }
        for (const project of projects) {
          console.log(`Indexing ${project.name} (${project.root}) ...`);
          // On a multi-thousand-file project the previous "..." silence
          // looked indistinguishable from a hang. Throttle progress to
          // one line every 2s — enough to confirm forward motion, not
          // enough to drown out the summary line in CI logs.
          const summary = await runtime.indexer.indexProject(project, {
            onProgress: makeProgressLogger(),
          });
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
      // Onboarding a specific project is the moment to offer agent wiring.
      if (path !== undefined) await maybeNudgeAgentSetup(resolve(path));
    });

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
        process.exit(EXIT.error);
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
          process.exit(EXIT.conflict);
        }
        console.error(`[loctx refresh] failed: ${errorMessage(err)}`);
        process.exit(EXIT.error);
      }
    });
}
