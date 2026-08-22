/**
 * Health checks for `loctx doctor` and the web UI's doctor page.
 *
 * Pure data — returns a list of {name, status, detail} entries. No
 * console output, no exit codes; the caller decides how to surface
 * them (CLI prints + exit 1 on error, web renders a table).
 *
 * Structure (CORE-3): each concern is a check function over a
 * {@link DoctorContext} built once per run — one StateStore open, one
 * WorkspaceDiscovery — instead of the former ~350-line function that
 * opened both twice. {@link runDoctorChecks} flattens the exported
 * {@link DOCTOR_CHECKS} list in order; check names, ordering, and
 * messages are unchanged.
 */

import { existsSync, statSync } from "node:fs";
import { detectLizard } from "./analyzers/index.js";
import type { Config } from "./config.js";
import { readActiveDaemon } from "./daemon-lock.js";
import { inventoryProjects, WorkspaceDiscovery } from "./discovery.js";
import { StateStore } from "./storage/state.js";
import { isModelTrusted } from "./trusted-models.js";
import { checkNofile, isHardLimitBound } from "./ulimit.js";
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

/**
 * Shared, read-only context every check receives. Built once per
 * doctor run so the StateStore and WorkspaceDiscovery aren't
 * constructed twice per call (CORE-3).
 */
export interface DoctorContext {
  readonly config: Config;
  readonly opts: DoctorOptions;
  /**
   * Whether the state DB file existed when the run started. Opening a
   * StateStore creates the file (and dataDir), so the "doesn't exist
   * yet" warning must be decided from this snapshot, not a live stat.
   */
  readonly stateDbExisted: boolean;
  /**
   * Open (and memoize) the shared StateStore. Lazy so the open — which
   * creates dataDir + the DB file on a fresh install — happens at the
   * same point in the check sequence it did pre-refactor (after the
   * path checks), keeping their output identical. Throws on open
   * failure; each caller reports it under its own check name, matching
   * the previous per-check open behavior.
   */
  readonly openState: () => StateStore;
  readonly discovery: WorkspaceDiscovery;
}

export type DoctorCheckFn = (ctx: DoctorContext) => DoctorCheck[] | Promise<DoctorCheck[]>;

function buildDoctorContext(
  config: Config,
  opts: DoctorOptions,
): { readonly ctx: DoctorContext; readonly close: () => void } {
  let cached: StateStore | null = null;
  const ctx: DoctorContext = {
    config,
    opts,
    stateDbExisted: existsSync(config.paths.stateDb),
    openState: () => {
      if (cached === null) cached = new StateStore(config.paths.stateDb);
      return cached;
    },
    discovery: new WorkspaceDiscovery(config.workspaceRoots),
  };
  return { ctx, close: () => cached?.close() };
}

function checkConfig({ config }: DoctorContext): DoctorCheck[] {
  return [
    {
      name: "config",
      status: "ok",
      detail: `loaded from ${config.source ?? "(defaults)"}`,
    },
  ];
}

function checkPaths({ config }: DoctorContext): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
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
  return checks;
}

function checkDaemon({ config }: DoctorContext): DoctorCheck[] {
  const lock = readActiveDaemon(config.paths.dataDir);
  return [
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
  ];
}

function checkState(ctx: DoctorContext): DoctorCheck[] {
  const { config, stateDbExisted } = ctx;
  if (!stateDbExisted) {
    return [
      {
        name: "state.sqlite3",
        status: "warn",
        detail: `${config.paths.stateDb} doesn't exist yet; run 'loctx index' to create it`,
      },
    ];
  }
  const checks: DoctorCheck[] = [];
  try {
    const state = ctx.openState();
    const projects = state.listProjects();
    checks.push({
      name: "state.sqlite3",
      status: "ok",
      detail: `${projects.length} project rows, schema healthy`,
    });
    // One GROUP BY instead of loading every file row per project (#455).
    let totalErrors = 0;
    for (const stats of state.fileStatsByProject().values()) {
      totalErrors += stats.errors;
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

    // FTS5 health probe — schema-healthy is not the same as
    // search-works. Some SQLite builds ship without FTS5; a
    // crash-corrupted virtual table can also throw on first MATCH.
    // We catch verbatim so the user sees the SQLite error and can
    // decide between rebuild-index and rebuild-sqlite.
    try {
      const probe = state.probeFts5();
      checks.push({
        name: "fts5",
        status: "ok",
        detail: `chunks_fts queryable, ${probe.rows} rows indexed`,
      });
    } catch (err) {
      checks.push({
        name: "fts5",
        status: "error",
        detail: `chunks_fts probe failed: ${(err as Error).message}. Lexical search unavailable; if SQLite lacks FTS5 set retrieval.mode = "vector" to bypass.`,
      });
    }
  } catch (err) {
    checks.push({
      name: "state.sqlite3",
      status: "error",
      detail: (err as Error).message,
    });
  }
  return checks;
}

function checkDiscovery({ config, discovery }: DoctorContext): DoctorCheck[] {
  try {
    const hits = discovery.discoverWithMarkers();
    if (hits.length === 0) {
      return [
        {
          name: "discovery",
          status: "warn",
          detail: `no project markers under ${config.workspaceRoots.join(", ")}`,
        },
      ];
    }
    const byKind = hits.reduce<Record<string, number>>((acc, h) => {
      acc[h.markerKind] = (acc[h.markerKind] ?? 0) + 1;
      return acc;
    }, {});
    const breakdown = Object.entries(byKind)
      .sort()
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    return [
      {
        name: "discovery",
        status: "ok",
        detail: `${hits.length} projects (${breakdown}) under ${config.workspaceRoots.join(", ")}`,
      },
    ];
  } catch (err) {
    return [
      {
        name: "discovery",
        status: "error",
        detail: (err as Error).message,
      },
    ];
  }
}

function checkEmbedding({ config }: DoctorContext): DoctorCheck[] {
  // The "huggingface-transformers" provider lazily downloads on first
  // use. Without this check, a user who switched models in config sees
  // doctor=ok and then waits through a ~90MB download (or fails
  // offline) on the next `loctx index` / first MCP search. Surface the
  // pending-download state up-front so the operator knows what to
  // expect. The `fake` provider used in tests has no download step;
  // skip the lookup for it.
  const embeddingDetail = `${config.embedding.provider}/${config.embedding.model} normalize=${config.embedding.normalize}${
    config.embedding.providerOverride ? ` override=${config.embedding.providerOverride}` : ""
  }`;
  // The fake provider override (test harness, LOCTX_EMBEDDING_PROVIDER=fake)
  // short-circuits real embedding entirely, so a missing trusted-models
  // entry isn't a real warning — the daemon never touches the HF cache.
  const usesLocal =
    config.embedding.provider === "huggingface-transformers" &&
    config.embedding.providerOverride !== "fake";
  const downloaded = usesLocal
    ? isModelTrusted(config.paths.dataDir, config.embedding.model)
    : true;
  return [
    {
      name: "embedding",
      status: downloaded ? "ok" : "warn",
      detail: downloaded
        ? embeddingDetail
        : `${embeddingDetail} — not yet downloaded; first index/search will trigger a ~90MB pull. Pre-stage with \`loctx model download ${config.embedding.model}\`.`,
    },
  ];
}

function checkRetrieval({ config }: DoctorContext): DoctorCheck[] {
  return [
    {
      name: "retrieval",
      status: "ok",
      detail: `mode=${config.retrieval.mode} rrfK=${config.retrieval.rrfK}`,
    },
  ];
}

function checkReconciliation(ctx: DoctorContext): DoctorCheck[] {
  try {
    // openState() creates the DB on a fresh install — same as the
    // pre-refactor per-check open did.
    const state = ctx.openState();
    const checks: DoctorCheck[] = [];
    const inv = inventoryProjects(ctx.discovery, state);
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

    // Sticky rebuild_pending_at flags. Pre-PR #299, a daemon kill
    // mid-rebuild would leave the flag set indefinitely and every
    // restart would re-run the rebuild from scratch. The new flow
    // clears per-project on success, but doctor still calls out
    // unresolved flags so the user sees "this project will trigger
    // a forced reindex on next start" before it surprises them.
    const pending = state.listProjectsWithRebuildPending();
    if (pending.length > 0) {
      const names = pending
        .map((p) => inv.active.find((a) => a.project.id === p.id)?.project.name ?? p.id)
        .join(", ");
      checks.push({
        name: "rebuild_pending",
        status: "warn",
        detail: `${pending.length} project(s) flagged for rebuild — will re-run on next reconcile: ${names}`,
      });
    } else {
      checks.push({
        name: "rebuild_pending",
        status: "ok",
        detail: "no projects flagged",
      });
    }
    return checks;
  } catch (err) {
    return [
      {
        name: "reconciliation",
        status: "error",
        detail: (err as Error).message,
      },
    ];
  }
}

function checkWatchers({ opts }: DoctorContext): DoctorCheck[] {
  // Surface per-project watcher health when running inside the daemon
  // (#160). A failed watcher silently stops emitting events; without
  // this check the user's first signal is stale search results.
  if (opts.watcherRegistry === undefined) return [];
  const watchers = opts.watcherRegistry.list();
  if (watchers.length === 0) {
    return [
      {
        name: "watchers",
        status: "warn",
        detail: "no active watchers (daemon may have been started with --no-watch)",
      },
    ];
  }
  const failed = watchers.filter((w) => w.state === "failed");
  const paused = watchers.filter((w) => w.state === "paused");
  const active = watchers.filter((w) => w.state === "active").length;
  if (failed.length > 0) {
    const reasons = failed
      .map((w) => `${w.projectName}: ${w.failureReason ?? "unknown"}`)
      .join("; ");
    return [
      {
        name: "watchers",
        status: "error",
        detail: `${failed.length} failed — ${reasons}. Try \`ulimit -n 10240\` if EMFILE/ENOSPC.`,
      },
    ];
  }
  if (paused.length > 0) {
    return [
      {
        name: "watchers",
        status: "warn",
        detail: `${active} active, ${paused.length} paused (${paused.map((w) => w.projectName).join(", ")})`,
      },
    ];
  }
  return [
    {
      name: "watchers",
      status: "ok",
      detail: `${active} active`,
    },
  ];
}

function checkUlimitNofile(_ctx: DoctorContext): DoctorCheck[] {
  const nofile = checkNofile();
  if (nofile === null) {
    return [{ name: "ulimit:nofile", status: "ok", detail: "n/a on this platform" }];
  }
  if (nofile.current === Number.POSITIVE_INFINITY) {
    return [{ name: "ulimit:nofile", status: "ok", detail: "unlimited" }];
  }
  const hardStr = Number.isFinite(nofile.hard) ? String(nofile.hard) : "unlimited";
  // When the HARD cap is below the floor, `ulimit -n` is a dead end —
  // macOS launchd caps every session; only launchctl + re-login raises it.
  const fix = isHardLimitBound(nofile)
    ? "hard cap is the constraint — `sudo launchctl limit maxfiles 65536 200000`, then log out and back in"
    : "bump with 'ulimit -n 10240'";
  return [
    {
      name: "ulimit:nofile",
      status: nofile.ok ? "ok" : "warn",
      detail: nofile.ok
        ? `${nofile.current} (>= ${nofile.recommended})`
        : `soft ${nofile.current}, hard ${hardStr} (< ${nofile.recommended} recommended) — ${fix}`,
    },
  ];
}

function checkAnalyzers({ config }: DoctorContext): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    {
      name: "analyzers",
      status: "ok",
      detail: config.analyzers.backgroundEnabled
        ? `background queue: concurrency=${config.analyzers.concurrency}, timeout=${config.analyzers.perTaskTimeoutMs}ms`
        : "background queue disabled (analyzers.background_enabled = false)",
    },
  ];
  if (config.analyzers.backgroundEnabled) {
    checks.push({
      name: "analyzers.duplicates",
      status: "ok",
      detail: config.analyzers.duplicates.enabled
        ? `enabled, window=${config.analyzers.duplicates.windowSize}, minTokens=${config.analyzers.duplicates.minUniqueTokens}`
        : "disabled (set analyzers.duplicates.enabled = true to opt in)",
    });
  }
  return checks;
}

async function checkLizard({ config }: DoctorContext): Promise<DoctorCheck[]> {
  // Only probe for lizard when the user actually has it enabled.
  // Previously we also probed when `background_enabled` was on, which
  // burned a 2s `execFile` even when lizard was never going to run —
  // visible on every doctor call (CLI + admin UI). See #219.
  if (!config.analyzers.lizard.enabled) return [];
  const found = await detectLizard(config.analyzers.lizard.command);
  return [
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
  ];
}

function checkNetwork({ config }: DoctorContext): DoctorCheck[] {
  // Network — only surfaced when non-default (proxied / firewalled setups).
  const net = config.network;
  if (net.caCert === null && net.proxy === null && net.strictSsl) return [];
  const parts: string[] = [];
  let status: DoctorStatus = "ok";
  if (net.caCert !== null) {
    const present = existsSync(net.caCert);
    parts.push(`ca_cert=${net.caCert}${present ? "" : " (FILE MISSING)"}`);
    if (!present) status = "error";
  }
  if (net.proxy !== null) parts.push(`proxy=${net.proxy}`);
  if (!net.strictSsl) {
    parts.push("strict_ssl=false (TLS verification OFF)");
    if (status === "ok") status = "warn";
  }
  return [{ name: "network", status, detail: parts.join(", ") }];
}

/** Ordered check list — the order defines the report's row order. */
export const DOCTOR_CHECKS: ReadonlyArray<DoctorCheckFn> = [
  checkConfig,
  checkPaths,
  checkDaemon,
  checkState,
  checkDiscovery,
  checkEmbedding,
  checkRetrieval,
  checkReconciliation,
  checkWatchers,
  checkUlimitNofile,
  checkAnalyzers,
  checkLizard,
  checkNetwork,
];

export async function runDoctorChecks(
  config: Config,
  opts: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const { ctx, close } = buildDoctorContext(config, opts);
  try {
    const results: DoctorCheck[][] = [];
    // Sequential on purpose: the checks are cheap except the lizard
    // probe, and running them in declaration order keeps side effects
    // (filesystem walks, SQLite reads, the lazy DB open) deterministic.
    for (const check of DOCTOR_CHECKS) {
      results.push(await check(ctx));
    }
    return results.flat();
  } finally {
    close();
  }
}

export function worstStatus(checks: ReadonlyArray<DoctorCheck>): DoctorStatus {
  let worst: DoctorStatus = "ok";
  for (const c of checks) {
    if (c.status === "error") return "error";
    if (c.status === "warn") worst = "warn";
  }
  return worst;
}
