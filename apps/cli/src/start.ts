/**
 * Integrated daemon orchestrator.
 *
 * Launches in one process:
 *   1. Build the runtime (StateStore, VectorStore, embeddings, indexer).
 *   2. Start a watcher per discovered project (unless --no-watch).
 *   3. Mount the Vite-built SPA + Hono API + /mcp on `daemon.port`
 *      (unless --no-web).
 *
 * Graceful shutdown: SIGINT / SIGTERM closes the HTTP server, then the
 * StateStore.
 */

import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireDaemonLock,
  buildRuntime,
  type Config,
  checkNofile,
  type DaemonLock,
  DaemonLockHeldError,
  findLegacyProjectConfig,
  inspectDaemonLockfile,
  inventoryProjects,
  loadConfig,
  looksLikeFdExhaustion,
  nofileBumpHint,
  type Project,
  type Runtime,
  readPackageVersion,
  stopActiveDaemon,
  summarizeLegacyProjectConfig,
  WatcherRegistry,
  WatcherService,
} from "@loctx/core";

// Real package version (#451) — one source of truth in package.json.
const DAEMON_VERSION = readPackageVersion(new URL("../package.json", import.meta.url));

/**
 * The set of analyzers that are currently *active* — i.e. would actually
 * run: the background queue is on, the analyzer is enabled, and (for the
 * rule-pack scanners) rule dirs are configured. Used to detect which
 * analyzers newly activated across a config hot-reload so we can backfill
 * just those over already-indexed files.
 */
function activeAnalyzers(config: Config): ReadonlySet<string> {
  const out = new Set<string>();
  const a = config.analyzers;
  if (!a.backgroundEnabled) return out;
  if (a.lizard.enabled) out.add("lizard");
  if (a.duplicates.enabled) out.add("duplicates");
  if (a.semgrep.enabled && a.semgrep.ruleDirs.length > 0) out.add("semgrep");
  if (a.astGrep.enabled && a.astGrep.ruleDirs.length > 0) out.add("ast-grep");
  return out;
}

export interface StartOptions {
  readonly enableWatch: boolean;
  readonly enableWeb: boolean;
  readonly replace: boolean; // if true, terminate any existing daemon first
  readonly webDir?: string;
}

// From `apps/cli/dist/start.js` to `apps/web`:
//   apps/cli/dist  +  ../../web  =  apps/web
const ROOT_RELATIVE_WEB_DIR = "../../web";

export async function start(bootConfig: Config, options: StartOptions): Promise<void> {
  // Live, mutable config. The admin UI hot-reloads it in place on save
  // (#config-hotreload): everything below reads through this object —
  // buildRuntime's analyzer enqueue hooks, the web /api/config payload,
  // reconciliation scheduling — so swapping its sections takes effect
  // without a restart. `bootConfig` is frozen; this shallow copy is
  // mutable so `reloadConfig` can Object.assign fresh sections onto it.
  // Settings that can't re-apply live (daemon port/hostname, embedding
  // model) still require a restart.
  const config: Config = { ...bootConfig };

  // Single-instance lock keyed on the data dir. Two daemons sharing the same
  // SQLite + LanceDB would race on writes; the lock keeps one alive at a time
  // regardless of how the second was launched (workspace, npm link, -g).
  const lock = await acquireOrReplaceLock(config, options);
  // Emit the legacy-project-config warning only after the lock is
  // ours. Two racing daemons would otherwise both print the warning
  // before the loser even discovers the conflict (#195).
  warnOnLegacyProjectConfig();

  let runtime: Runtime;
  try {
    runtime = await buildRuntime(config);
  } catch (err) {
    lock.release();
    throw err;
  }

  // Hot-reload hook for the admin UI's config save: re-read the YAML into
  // the live config, then — if an analyzer just became active — backfill
  // it over already-indexed files so enabling a feature after the index is
  // built catches up efficiently (only the new analyzer, only missing
  // files, no re-embedding). Defined after `runtime` so it can drive it.
  const reloadConfig = (): void => {
    const before = activeAnalyzers(config);
    const fresh = loadConfig(config.source !== null ? { configPath: config.source } : undefined);
    Object.assign(config, fresh);
    const newly = [...activeAnalyzers(config)].filter((n) => !before.has(n));
    if (newly.length > 0) {
      console.error(`[loctx config] analyzer(s) activated: ${newly.join(", ")} — backfilling`);
      void runtime
        .backfillAnalyzers(newly)
        .catch((err) =>
          console.error(`[loctx analyzers] backfill failed: ${(err as Error).message}`),
        );
    }
  };

  const discoveredProjects = runtime.discovery.discoverProjects();
  // Project activation gate: indexer / watcher / reconciler only operate
  // on user-activated projects. Discovered-but-inactive projects appear
  // in the admin UI with an Activate affordance.
  const inventory = inventoryProjects(runtime.discovery, runtime.state);
  const activeProjects: Project[] = inventory.active.map((a) => a.project);

  healLastIndexedAt(runtime, inventory.active);

  if (discoveredProjects.length === 0) {
    console.error(
      "[loctx start] no projects found under configured workspace_roots; " +
        "the watcher and admin UI will run but stay empty until projects are added.",
    );
  } else if (activeProjects.length === 0) {
    console.error(
      `[loctx start] ${discoveredProjects.length} project(s) discovered, none activated. Visit the /projects page or run \`loctx activate <path>\` to opt one in.`,
    );
  } else if (activeProjects.length < discoveredProjects.length) {
    const inactive = discoveredProjects.length - activeProjects.length;
    console.error(
      `[loctx start] ${activeProjects.length} active, ${inactive} inactive — see /projects to activate more.`,
    );
  }

  if (options.enableWatch) warnIfNofileLow(activeProjects.length);

  // Only build a registry when the watcher is actually running. The web
  // server uses `registry === undefined` to short-circuit pause/resume
  // with a clear 409 instead of a misleading 404.
  const watcherRegistry = options.enableWatch ? new WatcherRegistry() : undefined;
  const watchers =
    options.enableWatch && watcherRegistry !== undefined
      ? await startWatchers(runtime, activeProjects, config, watcherRegistry)
      : [];

  // Bring HTTP up BEFORE scheduling boot reconciliation. Reconciliation
  // failures during the very first pass (#198) should not knock the
  // daemon over before the admin UI / `/api/doctor` can even surface
  // them. The reconciler still runs in the background once scheduled —
  // it doesn't block startup — but it now waits for HTTP to be live.
  const httpStop = options.enableWeb
    ? await startWeb(config, options, runtime, watcherRegistry, reloadConfig)
    : async () => {
        /* no-op */
      };
  const reconciliationStop = startReconciliation(runtime, activeProjects, config);
  const maintenanceStop = startMaintenance(runtime, config);

  // Catch-up backfill for analyzers that were enabled while the index was
  // already built (e.g. config edited then daemon restarted, or upgraded
  // into the new enabled-by-default analyzers over an existing index).
  // Non-blocking; the missing-enrichment query is cheap once caught up, so
  // this is a no-op on a fully-analyzed index. Newly-indexed files are
  // covered by the indexer hook, not here.
  void runtime
    .backfillAnalyzers()
    .catch((err) =>
      console.error(`[loctx analyzers] startup backfill failed: ${(err as Error).message}`),
    );

  const banner = [
    `[loctx start] runtime ready (${activeProjects.length} active of ${discoveredProjects.length} discovered, ${runtime.config.embedding.model})`,
    options.enableWeb
      ? `[loctx start] admin UI:    http://${config.daemon.hostname}:${config.daemon.port}/`
      : null,
    options.enableWeb
      ? `[loctx start] MCP endpoint: http://${config.daemon.hostname}:${config.daemon.port}/mcp`
      : null,
    options.enableWatch ? `[loctx start] watcher running on ${watchers.length} project(s)` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  console.error(banner);

  // Pragmatic shutdown (#203): drain in dependency order — first stop
  // *generating* work (reconciler timer + watcher subscriptions), then
  // *serving* it (HTTP), then close the storage handle. SIGKILL at the
  // end because onnxruntime-node's C++ destructors crash on the way out
  // (GH#33). The OS reclaims the port + watcher fds + ONNX session as
  // soon as we exit; the goal of the drain is to avoid leaving SQLite
  // mid-transaction or HTTP requests with a closed state handle.
  //
  // Each stage has a hard timeout so a stuck watcher (#157) or hung
  // HTTP request can't pin shutdown. The signal handler itself is
  // async-aware: SIGKILL only fires after the drain attempts settle.
  const shutdown = async (signal: string): Promise<void> => {
    console.error(`\n[loctx start] shutting down (${signal})`);

    // 1. Stop scheduling new reconciliation work. Pure sync — just a
    //    flag flip + clearTimeout.
    try {
      reconciliationStop();
    } catch (err) {
      console.error(`[loctx start] reconciliation stop threw: ${(err as Error).message}`);
    }
    try {
      maintenanceStop();
    } catch (err) {
      console.error(`[loctx start] maintenance stop threw: ${(err as Error).message}`);
    }

    // 2. Tear watcher subscriptions down so no new index events fire
    //    while HTTP is being drained. Each stop() has its own internal
    //    5s timeout (see WatcherService.stop), but we cap the *batch*
    //    too so a buggy iteration can't hold us forever.
    if (watcherRegistry !== undefined) {
      await raceShutdownStep(
        "watcher stop",
        Promise.all(watchers.map((w) => w.stop().catch(() => undefined))),
        10_000,
      );
    }

    // 3. Drain HTTP. The Hono node-server's close() waits for in-flight
    //    requests; bound it so a slow client can't hold the daemon.
    await raceShutdownStep("http stop", httpStop(), 5_000);

    // 4. Close storage last so any final write from the drains above
    //    is flushed cleanly. Sync, can't hang.
    try {
      runtime.state.close();
    } catch {
      // best effort
    }
    try {
      lock.release();
    } catch {
      // best effort
    }
    process.kill(process.pid, "SIGKILL");
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Block until the signal handler exits the process.
  await new Promise<void>(() => undefined);

  // Unreachable; satisfies TypeScript's flow analysis.
  void watchers;
  void httpStop;
  void reconciliationStop;
}

// ---- reconciliation ----------------------------------------------------

function startReconciliation(
  runtime: Runtime,
  projects: ReadonlyArray<Project>,
  config: Config,
): () => void {
  const { runOnStart, intervalSeconds } = config.reconciliation;
  if (!runOnStart && intervalSeconds <= 0) return () => undefined;
  if (projects.length === 0) return () => undefined;

  // Priority reorder: any project with a persisted rebuild_pending_at
  // marker (left behind by /api/rebuild or `loctx rebuild` that didn't
  // run to completion) goes to the front of the queue. The reconciler's
  // content-sha guard makes resumption cheap — files already indexed
  // are skipped, only the unfinished tail gets embedded. After a
  // successful reconcile we clear the marker so subsequent passes don't
  // re-prioritise the same project forever.
  const pending = new Set(
    runtime.state.listProjectsWithRebuildPending().map((p) => p.id as string),
  );
  const orderedProjects: Project[] =
    pending.size === 0
      ? projects.slice()
      : [
          ...projects.filter((p) => pending.has(p.id)),
          ...projects.filter((p) => !pending.has(p.id)),
        ];
  if (pending.size > 0) {
    const names = orderedProjects
      .filter((p) => pending.has(p.id))
      .map((p) => p.name)
      .join(", ");
    console.error(`[loctx reconcile] resuming rebuild for: ${names}`);
  }

  // Exponential backoff on repeated failures so we don't hammer LanceDB
  // (or whatever else is broken) every interval. Caps at 1h; resets to
  // the configured interval on the first success.
  // Read the interval live so a hot-reloaded `reconciliation.interval_seconds`
  // applies on the next reschedule (no restart). The on/off transition at
  // boot is still fixed by the early guard above.
  const baseMs = (): number => config.reconciliation.intervalSeconds * 1000;
  const MAX_BACKOFF_MS = 60 * 60 * 1000;
  let consecutiveFailures = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const nextDelayMs = (): number => {
    if (consecutiveFailures === 0) return baseMs();
    return Math.min(baseMs() * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
  };

  const scheduleNext = (): void => {
    if (stopped || baseMs() <= 0) return;
    const delay = nextDelayMs();
    if (consecutiveFailures > 0) {
      const minutes = Math.round(delay / 60_000);
      console.error(
        `[loctx reconcile] backing off after ${consecutiveFailures} failure(s); next attempt in ~${minutes}m`,
      );
    }
    timer = setTimeout(() => run("periodic"), delay);
    timer.unref();
  };

  const run = (label: string): void => {
    // Short correlation ID per reconcile pass so an operator can match
    // an "entered" log to its "completed/failed" log when multiple
    // passes overlap with watcher events in the surrounding output
    // (#155). 6 random hex chars is plenty for human eyeballs.
    const traceId = Math.random().toString(16).slice(2, 8);
    const startedAt = Date.now();
    console.error(
      `[loctx reconcile ${traceId}] ${label} starting (${orderedProjects.length} project(s))`,
    );
    runtime.reconciler
      .reconcileAll(orderedProjects)
      .then((summaries) => {
        // `rebuild_pending_at` clearing moved into `reconcileProject`
        // itself so each project's flag clears the moment that project
        // finishes — surviving a mid-batch daemon kill. Used to live
        // here. See Reconciler.reconcileProject.
        const tally = summaries.reduce(
          (acc, s) => ({
            pruned: acc.pruned + s.pruned,
            reindexed: acc.reindexed + s.reindexed,
          }),
          { pruned: 0, reindexed: 0 },
        );
        const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
        console.error(
          `[loctx reconcile ${traceId}] ${label} complete (${summaries.length} project(s), ` +
            `pruned=${tally.pruned}, reindexed=${tally.reindexed}, elapsed=${elapsed}s)`,
        );
        consecutiveFailures = 0;
      })
      .catch((err) => {
        consecutiveFailures += 1;
        console.error(`[loctx reconcile ${traceId}] ${label} failed: ${(err as Error).message}`);
      })
      .finally(() => {
        // Schedule via setTimeout chain rather than setInterval so the
        // backoff updates take effect on the next tick rather than the
        // tick after.
        if (label === "periodic" || label === "startup") scheduleNext();
      });
  };

  if (runOnStart) {
    setImmediate(() => run("startup"));
  } else if (intervalSeconds > 0) {
    scheduleNext();
  }

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

// ---- maintenance (auto-compaction) -------------------------------------

/**
 * Periodically compact the vector store so a long-lived daemon doesn't
 * accumulate gigabytes of dead Lance version history (#index-size). The
 * store is append-only — every upsert/delete leaves an old fragment +
 * manifest behind that's never reclaimed otherwise.
 *
 * Mirrors the reconcile loop: a setTimeout chain (not setInterval) so a
 * hot-reloaded interval applies on the next reschedule, and the timer is
 * unref'd so it never keeps the process alive on its own.
 *
 *   - Disabled when `maintenance.compact_interval_hours` is 0.
 *   - First pass runs a few minutes after boot (capped to the interval) so
 *     an *upgraded* instance reclaims its existing bloat shortly after the
 *     restart, without a hot reindex fighting it.
 *   - Skipped (and retried shortly) while a reconcile is in flight — both
 *     contend for the LanceDB writer lock, and compaction during an active
 *     index pass would just be undone by the next write.
 */
function startMaintenance(runtime: Runtime, config: Config): () => void {
  const intervalMs = (): number => config.maintenance.compactIntervalHours * 60 * 60 * 1000;
  if (intervalMs() <= 0) return () => undefined;

  // Lead with a short delay after boot so upgrades auto-reclaim, but never
  // wait longer than the configured interval (relevant only for very short
  // test intervals).
  const INITIAL_DELAY_MS = Math.min(5 * 60 * 1000, intervalMs());
  // When a reconcile is in flight at compaction time, back off this long
  // and re-check rather than skipping a whole interval.
  const BUSY_RETRY_MS = 5 * 60 * 1000;

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void run(), delay);
    timer.unref();
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    if (runtime.reconciler.status().running) {
      console.error(
        `[loctx compact] reconcile in flight; deferring compaction ~${Math.round(BUSY_RETRY_MS / 60_000)}m`,
      );
      schedule(BUSY_RETRY_MS);
      return;
    }
    const startedAt = Date.now();
    console.error("[loctx compact] starting (merge fragments + prune version history)");
    try {
      const { beforeBytes, afterBytes } = await runtime.compactVectors();
      const mb = (n: number): string => (n / 1e6).toFixed(0);
      const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
      console.error(
        `[loctx compact] complete (${mb(beforeBytes)}MB → ${mb(afterBytes)}MB, ` +
          `freed ${mb(Math.max(0, beforeBytes - afterBytes))}MB, elapsed ${elapsed}s)`,
      );
    } catch (err) {
      console.error(`[loctx compact] failed: ${(err as Error).message}`);
    } finally {
      // Reschedule on the live interval so a hot-reloaded value takes
      // effect; bail if it was turned off (0) while we ran.
      if (!stopped && intervalMs() > 0) schedule(intervalMs());
    }
  };

  console.error(
    `[loctx compact] auto-compaction every ${config.maintenance.compactIntervalHours}h ` +
      `(first pass in ~${Math.round(INITIAL_DELAY_MS / 60_000)}m)`,
  );
  schedule(INITIAL_DELAY_MS);

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

// ---- preflight ---------------------------------------------------------

/**
 * The project-level `.loctx.yaml` layer was removed; values now live in
 * the global YAML editable from the admin UI. If we find a stray
 * `.loctx.yaml` walking up from cwd, surface it so the user knows their
 * old settings are being ignored.
 */
function warnOnLegacyProjectConfig(): void {
  const legacy = findLegacyProjectConfig(process.cwd());
  if (legacy === null) return;
  const leaves = summarizeLegacyProjectConfig(legacy);
  console.error(`[loctx start] WARNING: ${legacy} is no longer loaded.`);
  if (leaves.length > 0) {
    console.error(`[loctx start]          ignored settings: ${leaves.join(", ")}`);
    console.error(
      `[loctx start]          set these in the global config via the admin UI's /config page, or delete ${legacy} if you no longer need them.`,
    );
  } else {
    console.error(
      `[loctx start]          the file is empty or trivial; safe to delete (\`rm ${legacy}\`).`,
    );
  }
}

function warnIfNofileLow(projectCount: number): void {
  const status = checkNofile();
  if (status === null || status.ok) return;
  console.error(
    `[loctx start] WARNING: open-files limit is ${status.current} (recommended >= ${status.recommended}).`,
  );
  console.error(
    `[loctx start] chokidar opens ~1-2 fds per watched dir; with ${projectCount} project(s) this will likely flood with EMFILE.`,
  );
  console.error(
    nofileBumpHint()
      .split("\n")
      .map((l) => `[loctx start] ${l}`)
      .join("\n"),
  );
}

// ---- watchers ----------------------------------------------------------

async function startWatchers(
  runtime: Runtime,
  projects: ReadonlyArray<Project>,
  config: Config,
  registry: WatcherRegistry,
): Promise<WatcherService[]> {
  // Per-project try/catch so one failure (typically EMFILE on a workspace
  // larger than the kernel's inode budget) doesn't take down the whole
  // daemon. Failed projects show up in the registry with `state: failed`
  // and surface in /watchers + doctor; the remaining projects keep their
  // live updates. See #200.
  const settled = await Promise.all(
    projects.map(async (project) => {
      const w = new WatcherService(project, runtime.indexer, {
        debounceMs: config.watcher.debounceMs,
        onEvent: (event, relPath) => {
          console.error(`[loctx watch] ${event}\t${project.name}/${relPath}`);
        },
        onError: (event, relPath, err) => {
          console.error(`[watcher] ${event} ${relPath}: ${err.message}`);
          registry.markFailed(project.id, err.message);
        },
      });
      try {
        await w.start();
      } catch (err) {
        const message = (err as Error).message;
        // Register the entry as failed so the UI and doctor have
        // something to show. The watcher is not active; no events
        // will fire for this project until the daemon restarts after
        // the underlying issue is fixed.
        registry.register({
          projectId: project.id,
          projectName: project.name,
          projectRoot: project.root,
          watcher: w,
          startedAt: new Date().toISOString(),
          state: "failed",
          failureReason: message,
        });
        console.error(`[loctx start] watcher failed for ${project.name}: ${message}`);
        if (looksLikeFdExhaustion(message)) {
          console.error(
            nofileBumpHint()
              .split("\n")
              .map((l) => `[loctx start] ${l}`)
              .join("\n"),
          );
        }
        return null;
      }
      registry.register({
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.root,
        watcher: w,
        startedAt: new Date().toISOString(),
      });
      return w;
    }),
  );
  return settled.filter((w): w is WatcherService => w !== null);
}

// ---- web ---------------------------------------------------------------

async function startWeb(
  config: Config,
  options: StartOptions,
  runtime: Runtime,
  watcherRegistry: WatcherRegistry | undefined,
  onConfigWrite: () => void,
): Promise<() => Promise<void>> {
  const webDir = options.webDir ?? resolveWebDir();
  const staticDir = resolve(webDir, "dist", "client");
  const { port, hostname } = config.daemon;

  // Lazy: pulls in hono + the SPA bundle path. Not needed when --no-web.
  // Runtime-only import — keeping the types local avoids a compile-time
  // dep on @loctx/web (workspace builds in alphabetical order: cli before
  // web, so its `dist/` may not exist when tsc resolves cli).
  const serverModule = "@loctx/web/server";
  type WebServerModule = {
    createWebApp(opts: {
      readonly config: Config;
      readonly runtime?: Runtime;
      readonly watcherRegistry?: WatcherRegistry;
      readonly staticDir?: string;
      readonly onConfigWrite?: () => void | Promise<void>;
    }): { fetch: (req: Request) => Promise<Response> };
  };
  type HonoNodeServerModule = {
    serve(opts: { fetch: (req: Request) => Promise<Response>; port?: number; hostname?: string }): {
      close(cb: (err?: Error) => void): void;
    };
  };
  const { createWebApp } = (await import(serverModule)) as WebServerModule;
  const { serve } = (await import("@hono/node-server")) as HonoNodeServerModule;

  const app = createWebApp({
    config,
    runtime,
    staticDir,
    onConfigWrite,
    ...(watcherRegistry !== undefined ? { watcherRegistry } : {}),
  });
  const handle = app.fetch;

  // Dual-stack loopback bind. `hostname: localhost` resolves to a single
  // address (on macOS, usually `::1`), which means browsers configured
  // to prefer IPv4 silently fail with no fallback. Listen on both
  // `127.0.0.1` and `::1` whenever the user's intent is loopback —
  // matches what they expect from "localhost" without exposing the
  // daemon on other interfaces. Custom hostnames bind unchanged.
  const servers = startListeners({ serve, handle, port, hostname });

  return async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolveClose, reject) => {
            server.close((err) => (err ? reject(err) : resolveClose()));
          }),
      ),
    );
  };
}

function startListeners(args: {
  readonly serve: (opts: {
    fetch: (req: Request) => Promise<Response>;
    port?: number;
    hostname?: string;
  }) => { close(cb: (err?: Error) => void): void };
  readonly handle: (req: Request) => Promise<Response>;
  readonly port: number;
  readonly hostname: string;
}): Array<{ close(cb: (err?: Error) => void): void }> {
  const { serve, handle, port, hostname } = args;
  const targets = hostname === "localhost" ? ["127.0.0.1", "::1"] : [hostname];
  return targets.map((h) => serve({ fetch: handle, port, hostname: h }));
}

// ---- helpers -----------------------------------------------------------

function resolveWebDir(): string {
  // Resolve @loctx/web's package root from wherever it's installed, via its
  // exported `./server` entry. Works both in the workspace (pnpm symlinks
  // @loctx/web → apps/web) and in a published/bundled install (it lives in
  // node_modules/@loctx/web) — the old hardcoded `../../web` only held for
  // the former. Falls back to the relative path if resolution fails.
  try {
    const require = createRequire(import.meta.url);
    const serverEntry = require.resolve("@loctx/web/server");
    const marker = `${sep}dist${sep}`;
    const distIdx = serverEntry.lastIndexOf(marker);
    if (distIdx !== -1) return serverEntry.slice(0, distIdx);
  } catch {
    // fall through to the workspace-relative path
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, ROOT_RELATIVE_WEB_DIR);
}

/**
 * Bound a single shutdown step so a stuck subsystem (hung watcher
 * unsubscribe, slow HTTP request) can't pin the daemon's drain.
 * Logs the outcome but never rejects — the caller has nowhere
 * meaningful to surface a shutdown failure.
 */
async function raceShutdownStep(
  label: string,
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
  });
  try {
    const winner = await Promise.race([work.then(() => "ok" as const), timeout]);
    if (winner === "timeout") {
      console.error(`[loctx start] ${label} hung past ${timeoutMs}ms; abandoning`);
    }
  } catch (err) {
    console.error(`[loctx start] ${label} threw: ${(err as Error).message}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Backfill projects.last_indexed_at from the newest file row when the project stamp is null (#275).
function healLastIndexedAt(
  runtime: Runtime,
  activeProjects: ReadonlyArray<{
    readonly project: Project;
    readonly lastIndexedAt: string | null;
  }>,
): void {
  let healed = 0;
  for (const entry of activeProjects) {
    if (entry.lastIndexedAt !== null) continue;
    const files = runtime.state.listFiles(entry.project.id);
    if (files.length === 0) continue;
    let newest: string | null = null;
    for (const f of files) {
      if (f.indexedAt !== null && (newest === null || f.indexedAt > newest)) {
        newest = f.indexedAt;
      }
    }
    if (newest !== null) {
      runtime.state.markProjectIndexed(entry.project.id, new Date(newest));
      healed += 1;
    }
  }
  if (healed > 0) {
    console.error(`[loctx start] backfilled last_indexed_at for ${healed} project(s) (#275)`);
  }
}

async function acquireOrReplaceLock(config: Config, options: StartOptions): Promise<DaemonLock> {
  const info = {
    pid: process.pid,
    port: config.daemon.port,
    hostname: config.daemon.hostname,
    startedAt: new Date().toISOString(),
    version: DAEMON_VERSION,
  };

  // Diagnose what we're walking into before acquiring. `acquireDaemonLock`
  // reclaims stale lockfiles silently, which is the right behavior but
  // hides a useful signal: when a previous daemon crashed or was
  // SIGKILL'd, users hit "I restarted and nothing happened" mysteries.
  // Surfacing the reclaim as a visible log line on stderr makes that
  // class of incident self-diagnosing.
  const status = inspectDaemonLockfile(config.paths.dataDir);
  if (status.kind === "stale") {
    console.error(
      `[loctx start] reclaiming stale lockfile (PID ${status.info.pid} from ${status.info.startedAt} is no longer running)`,
    );
  } else if (status.kind === "corrupt") {
    console.error(
      "[loctx start] previous lockfile was corrupt; replacing it. (Possible cause: filesystem crash mid-write.)",
    );
  }

  try {
    return acquireDaemonLock(config.paths.dataDir, info);
  } catch (err) {
    if (!(err instanceof DaemonLockHeldError) || !options.replace) throw err;

    console.error(
      `[loctx start] terminating existing daemon (PID ${err.holder.pid}) before starting...`,
    );
    await stopActiveDaemon(config.paths.dataDir);
    return acquireDaemonLock(config.paths.dataDir, info);
  }
}
