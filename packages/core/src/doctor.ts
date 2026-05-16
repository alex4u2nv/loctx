/**
 * Health checks for `loctx doctor` and the web UI's doctor page.
 *
 * Pure data — returns a list of {name, status, detail} entries. No
 * console output, no exit codes; the caller decides how to surface
 * them (CLI prints + exit 1 on error, web renders a table).
 */

import { existsSync, statSync } from "node:fs";
import { detectLizard } from "./analyzers/index.js";
import type { Config } from "./config.js";
import { readActiveDaemon } from "./daemon-lock.js";
import { WorkspaceDiscovery, inventoryProjects } from "./discovery.js";
import { StateStore } from "./storage/state.js";
import { checkNofile } from "./ulimit.js";
import type { WatcherRegistry } from "./watcher/registry.js";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface DoctorOptions {
  /**
   * Pass the daemon's live registry to surface per-project watcher
   * health (active / paused / failed) and EMFILE-style failure
   * reasons. Only the in-process daemon has access; the standalone
   * `loctx doctor` CLI command leaves this unset and just doesn't emit
   * watcher checks.
   */
  readonly watcherRegistry?: WatcherRegistry;
}

export async function runDoctorChecks(
  config: Config,
  opts: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "config",
    status: "ok",
    detail: `loaded from ${config.source ?? "(defaults)"}`,
  });

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
          totalErrors += state.listFiles(p.id).filter((f) => f.error !== null).length;
        }
        checks.push(
          totalErrors > 0
            ? {
                name: "index errors",
                status: "warn",
                detail: `${totalErrors} files indexed with errors (run 'loctx index' to retry)`,
              }
            : { name: "index errors", status: "ok", detail: "none" },
        );
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

  try {
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const hits = discovery.discoverWithMarkers();
    if (hits.length === 0) {
      checks.push({
        name: "discovery",
        status: "warn",
        detail: `no project markers under ${config.workspaceRoots.join(", ")}`,
      });
    } else {
      const byKind = hits.reduce<Record<string, number>>((acc, h) => {
        acc[h.markerKind] = (acc[h.markerKind] ?? 0) + 1;
        return acc;
      }, {});
      const breakdown = Object.entries(byKind)
        .sort()
        .map(([k, n]) => `${k}=${n}`)
        .join(", ");
      checks.push({
        name: "discovery",
        status: "ok",
        detail: `${hits.length} projects (${breakdown}) under ${config.workspaceRoots.join(", ")}`,
      });
    }
  } catch (err) {
    checks.push({
      name: "discovery",
      status: "error",
      detail: (err as Error).message,
    });
  }

  checks.push({
    name: "embedding",
    status: "ok",
    detail: `${config.embedding.provider}/${config.embedding.model} normalize=${config.embedding.normalize}${
      config.embedding.providerOverride ? ` override=${config.embedding.providerOverride}` : ""
    }`,
  });

  checks.push({
    name: "retrieval",
    status: "ok",
    detail: `mode=${config.retrieval.mode} rrfK=${config.retrieval.rrfK}`,
  });

  try {
    const discovery2 = new WorkspaceDiscovery(config.workspaceRoots);
    const state = new StateStore(config.paths.stateDb);
    try {
      const inv = inventoryProjects(discovery2, state);
      const stale = inv.active.filter((a) => a.lastReconciledAt === null);
      const totalActive = inv.active.length;
      checks.push({
        name: "reconciliation",
        status: stale.length === 0 ? "ok" : "warn",
        detail:
          totalActive === 0
            ? "no active projects"
            : `${totalActive - stale.length}/${totalActive} reconciled${
                stale.length > 0
                  ? ` — never run for: ${stale.map((s) => s.project.name).join(", ")}`
                  : ""
              }`,
      });
    } finally {
      state.close();
    }
  } catch (err) {
    checks.push({
      name: "reconciliation",
      status: "error",
      detail: (err as Error).message,
    });
  }

  // Surface per-project watcher health when running inside the daemon
  // (#160). A failed watcher silently stops emitting events; without
  // this check the user's first signal is stale search results.
  if (opts.watcherRegistry !== undefined) {
    const watchers = opts.watcherRegistry.list();
    if (watchers.length === 0) {
      checks.push({
        name: "watchers",
        status: "warn",
        detail: "no active watchers (daemon may have been started with --no-watch)",
      });
    } else {
      const failed = watchers.filter((w) => w.state === "failed");
      const paused = watchers.filter((w) => w.state === "paused");
      const active = watchers.filter((w) => w.state === "active").length;
      if (failed.length > 0) {
        const reasons = failed
          .map((w) => `${w.projectName}: ${w.failureReason ?? "unknown"}`)
          .join("; ");
        checks.push({
          name: "watchers",
          status: "error",
          detail: `${failed.length} failed — ${reasons}. Try \`ulimit -n 10240\` if EMFILE/ENOSPC.`,
        });
      } else if (paused.length > 0) {
        checks.push({
          name: "watchers",
          status: "warn",
          detail: `${active} active, ${paused.length} paused (${paused.map((w) => w.projectName).join(", ")})`,
        });
      } else {
        checks.push({
          name: "watchers",
          status: "ok",
          detail: `${active} active`,
        });
      }
    }
  }

  const nofile = checkNofile();
  if (nofile === null) {
    checks.push({ name: "ulimit:nofile", status: "ok", detail: "n/a on this platform" });
  } else if (nofile.current === Number.POSITIVE_INFINITY) {
    checks.push({ name: "ulimit:nofile", status: "ok", detail: "unlimited" });
  } else {
    checks.push({
      name: "ulimit:nofile",
      status: nofile.ok ? "ok" : "warn",
      detail: nofile.ok
        ? `${nofile.current} (>= ${nofile.recommended})`
        : `${nofile.current} (< ${nofile.recommended} recommended) — bump with 'ulimit -n 10240'`,
    });
  }

  checks.push({
    name: "analyzers",
    status: "ok",
    detail: config.analyzers.backgroundEnabled
      ? `background queue: concurrency=${config.analyzers.concurrency}, timeout=${config.analyzers.perTaskTimeoutMs}ms`
      : "background queue disabled (analyzers.background_enabled = false)",
  });

  if (config.analyzers.backgroundEnabled) {
    checks.push({
      name: "analyzers.duplicates",
      status: "ok",
      detail: config.analyzers.duplicates.enabled
        ? `enabled, window=${config.analyzers.duplicates.windowSize}, minTokens=${config.analyzers.duplicates.minUniqueTokens}`
        : "disabled (set analyzers.duplicates.enabled = true to opt in)",
    });
  }

  // Only probe for lizard when the user actually has it enabled.
  // Previously we also probed when `background_enabled` was on, which
  // burned a 2s `execFile` even when lizard was never going to run —
  // visible on every doctor call (CLI + admin UI). See #219.
  if (config.analyzers.lizard.enabled) {
    const found = await detectLizard(config.analyzers.lizard.command);
    checks.push(
      found === null
        ? {
            name: "analyzers.lizard",
            status: "warn",
            detail: `enabled but '${config.analyzers.lizard.command}' not found on PATH; install lizard or unset analyzers.lizard.enabled`,
          }
        : {
            name: "analyzers.lizard",
            status: "ok",
            detail: `enabled, command='${found}'`,
          },
    );
  }

  return checks;
}

export function worstStatus(checks: ReadonlyArray<DoctorCheck>): DoctorStatus {
  let worst: DoctorStatus = "ok";
  for (const c of checks) {
    if (c.status === "error") return "error";
    if (c.status === "warn") worst = "warn";
  }
  return worst;
}
