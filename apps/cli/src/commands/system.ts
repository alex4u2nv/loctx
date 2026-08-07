/**
 * `doctor` and `status` — health and diagnostics.
 */

import {
  daemonClient,
  inventoryProjects,
  type ProjectId,
  readActiveDaemon,
  runDoctorChecks,
  StateStore,
  WorkspaceDiscovery,
  worstStatus,
} from "@loctx/core";
import type { Command } from "commander";
import { EXIT, getCtx, loadConfigOrFail } from "../lib/context.js";

export function registerSystemCommands(program: Command): void {
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
      if (worst === "error") process.exit(EXIT.error);
    });

  program
    .command("status")
    .description("Report configured workspace, storage, and index state.")
    .action(async () => {
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);
      const discovery = new WorkspaceDiscovery(config.workspaceRoots);
      const state = new StateStore(config.paths.stateDb);
      let inventory: ReturnType<typeof inventoryProjects>;
      let pendingRebuilds: ReadonlyArray<{ id: ProjectId; rebuildPendingAt: string }>;
      try {
        inventory = inventoryProjects(discovery, state);
        pendingRebuilds = state.listProjectsWithRebuildPending();
      } finally {
        state.close();
      }

      const daemon = readActiveDaemon(config.paths.dataDir);
      const daemonRow: string = daemon
        ? `running (PID ${daemon.pid}${daemon.port ? `, http://${daemon.hostname ?? "localhost"}:${daemon.port}` : ""}, started ${daemon.startedAt})`
        : "not running";

      // When the daemon is up, fetch its live reconciliation state so the
      // CLI tells the user when results may be partial (#46 / mirrors the
      // admin UI's reconcile banner and the MCP indexHealth field).
      let reconcileLine: string | null = null;
      if (daemon !== null) {
        try {
          const client = daemonClient(config.paths.dataDir);
          const status = await client.get<{
            reconciliation?: {
              running: boolean;
              currentProjectName: string | null;
              completed: number;
              total: number;
              currentProjectIndexed: number | null;
              currentProjectTotal: number | null;
            };
          }>("/api/status");
          const r = status.reconciliation;
          if (r?.running) {
            const fileLabel =
              r.currentProjectIndexed !== null && r.currentProjectTotal !== null
                ? `, ${r.currentProjectIndexed}/${r.currentProjectTotal} files`
                : "";
            reconcileLine = `reconciling — project ${r.completed + 1}/${r.total}: ${r.currentProjectName ?? "?"}${fileLabel}`;
          }
        } catch {
          // Daemon up but unreachable on /api/status; skip the live row.
        }
      }

      console.log("loctx status:");
      const rows: ReadonlyArray<readonly [string, string]> = [
        ["config", config.source ?? `${ctx.configPath} (default)`],
        ["daemon", daemonRow],
        ...(reconcileLine !== null ? ([["reconcile", reconcileLine]] as const) : []),
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
      // Set<ProjectId> by inference — no brand-stripping `as string`
      // (2026-08-06 audit "also noted"); Project.id is the same brand.
      const pendingSet = new Set(pendingRebuilds.map((p) => p.id));
      console.log(`  active projects (${inventory.active.length}):`);
      for (const { project, lastIndexedAt, marker, markerKind } of inventory.active) {
        const stamp = lastIndexedAt ? `  (indexed ${lastIndexedAt})` : "";
        const tag = `[${marker}${markerKind !== "git" ? `:${markerKind}` : ""}]`;
        const pending = pendingSet.has(project.id) ? "  ⚠ rebuild_pending" : "";
        console.log(
          `    ${project.id}  ${project.name}  ${project.root}  ${tag}${stamp}${pending}`,
        );
      }
      if (inventory.orphaned.length > 0) {
        console.log(`  orphaned projects (${inventory.orphaned.length}, still queryable):`);
        for (const { project, reason, rootExists } of inventory.orphaned) {
          const tag = rootExists ? `[${reason}]` : "[missing]";
          console.log(`    ${project.id}  ${project.name}  ${project.root}  ${tag}`);
        }
      }
    });
}
