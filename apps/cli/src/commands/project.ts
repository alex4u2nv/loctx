/**
 * Project lifecycle commands. Activation (`add`, `activate`,
 * `deactivate`) and maintenance (`pause`, `resume`, `rebuild`, `purge`)
 * are registered by two functions so `cli.ts` can slot them at their
 * original positions in the command list while keeping the concern in
 * one file.
 */

import {
  DaemonHttpError,
  type IndexSummary,
  type Project,
  purgeProjectVectors,
  type Runtime,
} from "@loctx/core";
import type { Command } from "commander";
import { maybeNudgeAgentSetup } from "../lib/agent-setup.js";
import { confirm, EXIT, fail, noProjectMarkerError, resolveCommandPath } from "../lib/context.js";
import {
  makeProgressLogger,
  resolveScopedTargets,
  withDaemonClient,
  withDaemonOrLocal,
} from "../lib/daemon-io.js";

/**
 * `loctx add` is the friendly entry point: run it from anywhere inside
 * a project (or pass an explicit PATH) and it walks up to the nearest
 * marker, confirms with the user, then activates indexing. `activate`
 * is kept as a non-interactive synonym for scripts and existing muscle
 * memory.
 *
 * No `fallbackOnError`: a daemon activation failure must surface, not
 * silently degrade to a second uncoordinated writer (#322).
 */
export async function runActivate(project: Project): Promise<void> {
  await withDaemonOrLocal({
    localRuntime: "full",
    viaDaemon: async (client) => {
      await client.post("/api/projects/activate", { path: project.root });
      console.error(`[loctx activate] ${project.name} (${project.root}) — via daemon`);
    },
    viaLocal: async (runtime) => {
      runtime.state.upsertProjectWithActive(project, true);
      console.error(`[loctx activate] ${project.name} (${project.root})`);
      const summary = await runtime.indexer.indexProject(project);
      console.error(
        `[loctx activate] initial index: indexed=${summary.indexed} skipped=${summary.skipped} failed=${summary.failed}`,
      );
    },
  });
  await maybeNudgeAgentSetup(project.root);
}

export function registerProjectActivation(program: Command): void {
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
        noProjectMarkerError(
          "add",
          path,
          "\n  Expected one of: .git, .vscode, .idea, package.json, pyproject.toml, Cargo.toml, go.mod, …",
        );
      }
      console.error(`[loctx add] resolved project: ${project.name} (${project.root})`);
      if (!opts.yes) {
        const ok = await confirm("Activate indexing for this project?");
        if (!ok) {
          fail("[loctx add] aborted.");
        }
      }
      await runActivate(project);
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
        noProjectMarkerError("activate", path);
      }
      await runActivate(project);
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
        noProjectMarkerError("deactivate", path);
      }
      await withDaemonOrLocal({
        localRuntime: "state",
        viaDaemon: async (client) => {
          await client.post("/api/projects/deactivate", { path: project.root });
          console.error(`[loctx deactivate] ${project.name} (${project.root}) — via daemon`);
        },
        viaLocal: async (runtime) => {
          const ok = runtime.state.setProjectActive(project.id, false);
          if (!ok) {
            // exitCode + return (not process.exit) so the state store
            // close in withDaemonOrLocal's finally still runs (CLI-7).
            console.error(
              `[loctx deactivate] no state row for ${project.root} — nothing to deactivate.`,
            );
            process.exitCode = EXIT.error;
            return;
          }
          console.error(`[loctx deactivate] ${project.name} (${project.root})`);
        },
      });
    });
}

/**
 * The local (no-daemon) rebuild sequence for one project — the same
 * purge-then-index pass the daemon endpoint runs. Data in, data out
 * (CLI-6, 2026-08-06 audit): printing stays in the command handler.
 */
async function runRebuild(runtime: Runtime, project: Project): Promise<IndexSummary> {
  // Persist rebuild intent before the destructive purge — a crash
  // here leaves a marker the next `loctx start` will pick up and
  // resume with priority. Keeps the project row alive so the
  // marker survives.
  runtime.state.upsertProjectWithActive(project, true);
  runtime.state.markProjectRebuildPending(project.id);
  await runtime.vectors.deleteProjectChunks(project.id);
  runtime.state.purgeProjectContents(project.id);
  const summary = await runtime.indexer.indexProject(project, {
    onProgress: makeProgressLogger(),
  });
  // Rebuild is a strict superset of a reconcile pass — stamp
  // last_reconciled_at so doctor + the projects page don't show
  // a stale "reconciled —" right after.
  runtime.state.markProjectReconciled(project.id);
  runtime.state.clearProjectRebuildPending(project.id);
  return summary;
}

export function registerProjectMaintenance(program: Command): void {
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
      const resolved = opts.all ? null : resolveCommandPath(path);
      if (!opts.all && resolved === null) {
        noProjectMarkerError("rebuild", path, " Pass --all to rebuild every project.");
      }
      if (!opts.force) {
        const target = opts.all
          ? "EVERY project"
          : `${resolved?.name ?? ""} at ${resolved?.root ?? ""}`;
        fail(
          `[loctx rebuild] refusing without --force.\n  This deletes every chunk + vector row for ${target}\n  and re-indexes from scratch. Source files are untouched.`,
        );
      }
      await withDaemonOrLocal({
        localRuntime: "full",
        viaDaemon: async (client) => {
          // /api/rebuild is async — the daemon enqueues per-project rebuilds
          // and returns 202 (accepted, with the accept/reject split) or 409
          // (all rejected; same shape). The CLI splits the cases so the
          // 409 "everything already in progress" path isn't surfaced as a
          // raw JSON dump by the generic daemon-error handler.
          type RebuildResponse = {
            ok: boolean;
            accepted: Array<{ projectId: string; name: string }>;
            rejected?: Array<{ projectId: string; name: string; reason: string }>;
          };
          let r: RebuildResponse;
          try {
            r = await client.post<RebuildResponse>(
              "/api/rebuild",
              resolved !== null ? { path: resolved.root } : {},
            );
          } catch (err) {
            // 409 = all rejected — body has the same shape as the success
            // case, just every entry in `rejected`. Pretty-print instead of
            // letting the generic handler dump the JSON.
            if (err instanceof DaemonHttpError && err.status === 409) {
              try {
                r = JSON.parse(err.body) as RebuildResponse;
              } catch {
                throw err;
              }
            } else {
              throw err;
            }
          }
          for (const a of r.accepted) {
            console.log(`accepted ${a.name} for rebuild`);
          }
          for (const rej of r.rejected ?? []) {
            console.error(`[loctx rebuild] skipped ${rej.name}: ${rej.reason}`);
          }
          if (r.accepted.length > 0) {
            console.error(
              `[loctx rebuild] ${r.accepted.length} project(s) enqueued — async. Watch progress with \`loctx status\` or in the admin UI's projects page.`,
            );
          } else if ((r.rejected ?? []).length > 0) {
            fail("[loctx rebuild] no projects accepted — see reasons above.", EXIT.conflict);
          }
        },
        // No-daemon fallback: same purge-then-index sequence the daemon endpoint runs.
        viaLocal: async (runtime) => {
          const projects = resolved !== null ? [resolved] : runtime.discovery.discoverProjects();
          for (const project of projects) {
            console.log(`Rebuilding ${project.name} (${project.root}) ...`);
            const summary = await runRebuild(runtime, project);
            console.log(
              `  indexed=${summary.indexed} skipped=${summary.skipped} failed=${summary.failed} (${summary.elapsedSeconds.toFixed(2)}s)`,
            );
          }
        },
      });
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
        noProjectMarkerError("purge", path);
      }
      if (!opts.force) {
        fail(
          `[loctx purge] refusing without --force.\n  This deletes every chunk + vector row for ${project.name} at\n  ${project.root}. Source files are untouched.`,
        );
      }
      await withDaemonOrLocal({
        localRuntime: "state",
        viaDaemon: async (client) => {
          const r = await client.post<{ project: { name: string; root: string } }>(
            "/api/reset/project",
            { path: project.root },
          );
          console.error(`[loctx purge] cleared ${r.project.name} (${r.project.root}) via daemon.`);
        },
        // No-daemon fallback: drop the project's vectors + state in-process.
        // State-only runtime + registry-driven vector delete — no embedding
        // model load (#448). Deleting via the collection registry also
        // reaches rows written under a previous embedding model, which the
        // old identity-derived path missed.
        viaLocal: async (runtime) => {
          await purgeProjectVectors(
            runtime.config.paths.vectorDir,
            runtime.state.listCollections(),
            project.id,
          );
          runtime.state.deleteProject(project.id);
          console.error(`[loctx purge] cleared ${project.name} (${project.root}).`);
        },
      });
    });
}
