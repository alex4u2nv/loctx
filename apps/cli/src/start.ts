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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Config,
  type DaemonLock,
  DaemonLockHeldError,
  type Project,
  type Runtime,
  WatcherRegistry,
  WatcherService,
  acquireDaemonLock,
  buildRuntime,
  checkNofile,
  findLegacyProjectConfig,
  inventoryProjects,
  looksLikeFdExhaustion,
  nofileBumpHint,
  stopActiveDaemon,
} from "@loctx/core";

const DAEMON_VERSION = "0.1.0";

export interface StartOptions {
  readonly enableWatch: boolean;
  readonly enableWeb: boolean;
  readonly replace: boolean; // if true, terminate any existing daemon first
  readonly webDir?: string;
}

// From `apps/cli/dist/start.js` to `apps/web`:
//   apps/cli/dist  +  ../../web  =  apps/web
const ROOT_RELATIVE_WEB_DIR = "../../web";

export async function start(config: Config, options: StartOptions): Promise<void> {
  warnOnLegacyProjectConfig();
  // Single-instance lock keyed on the data dir. Two daemons sharing the same
  // SQLite + LanceDB would race on writes; the lock keeps one alive at a time
  // regardless of how the second was launched (workspace, npm link, -g).
  const lock = await acquireOrReplaceLock(config, options);

  let runtime: Runtime;
  try {
    runtime = await buildRuntime(config);
  } catch (err) {
    lock.release();
    throw err;
  }

  const discoveredProjects = runtime.discovery.discoverProjects();
  // Project activation gate: indexer / watcher / reconciler only operate
  // on user-activated projects. Discovered-but-inactive projects appear
  // in the admin UI with an Activate affordance.
  const inventory = inventoryProjects(runtime.discovery, runtime.state);
  const activeProjects: Project[] = inventory.active.map((a) => a.project);

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

  // Reconciliation (#14): catch up after the daemon was offline. We kick
  // off boot reconciliation in the background so the HTTP / MCP surface
  // doesn't wait on a long full-corpus walk; the watcher is already
  // catching live events. The periodic timer drifts indefinitely until
  // shutdown.
  const reconciliationStop = startReconciliation(runtime, activeProjects, config);
  const httpStop = options.enableWeb
    ? await startWeb(config, options, runtime, watcherRegistry)
    : async () => {
        /* no-op */
      };

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

  // Pragmatic shutdown: install signal handlers that close the SQLite state
  // synchronously (so WAL flushes) and process.exit immediately. Trying to
  // await Next.js app.close(), chokidar.close(), or HF transformers'
  // dispose() reliably hangs on Node 25 + onnxruntime-node — see GH#33.
  // The OS releases the port, watcher fds, and ONNX session as soon as
  // we exit.
  const shutdown = (signal: string): void => {
    console.error(`\n[loctx start] shutting down (${signal})`);
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
    // SIGKILL ourselves so onnxruntime-node's C++ destructors don't run on
    // the way out — they crash with `libc++abi: mutex lock failed` (GH#33).
    // The state DB has already been closed; nothing else needs orderly
    // teardown that the OS won't reclaim.
    process.kill(process.pid, "SIGKILL");
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

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

  // Exponential backoff on repeated failures so we don't hammer LanceDB
  // (or whatever else is broken) every interval. Caps at 1h; resets to
  // the configured interval on the first success.
  const baseMs = intervalSeconds * 1000;
  const MAX_BACKOFF_MS = 60 * 60 * 1000;
  let consecutiveFailures = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const nextDelayMs = (): number => {
    if (consecutiveFailures === 0) return baseMs;
    return Math.min(baseMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
  };

  const scheduleNext = (): void => {
    if (stopped || baseMs <= 0) return;
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
    runtime.reconciler
      .reconcileAll(projects)
      .then((summaries) => {
        const tally = summaries.reduce(
          (acc, s) => ({
            pruned: acc.pruned + s.pruned,
            reindexed: acc.reindexed + s.reindexed,
          }),
          { pruned: 0, reindexed: 0 },
        );
        console.error(
          `[loctx reconcile] ${label} complete (${summaries.length} project(s), ` +
            `pruned=${tally.pruned}, reindexed=${tally.reindexed})`,
        );
        consecutiveFailures = 0;
      })
      .catch((err) => {
        consecutiveFailures += 1;
        console.error(`[loctx reconcile] ${label} failed: ${(err as Error).message}`);
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
  console.error(
    `[loctx start] WARNING: ${legacy} is no longer loaded. Project-level config was removed; move its contents into the global config (edit via the admin UI or \`loctx config show\`).`,
  );
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
    }): { fetch: (req: Request) => Promise<Response> };
  };
  type HonoNodeServerModule = {
    serve(opts: {
      fetch: (req: Request) => Promise<Response>;
      port?: number;
      hostname?: string;
    }): { close(cb: (err?: Error) => void): void };
  };
  const { createWebApp } = (await import(serverModule)) as WebServerModule;
  const { serve } = (await import("@hono/node-server")) as HonoNodeServerModule;

  const app = createWebApp({
    config,
    runtime,
    staticDir,
    ...(watcherRegistry !== undefined ? { watcherRegistry } : {}),
  });
  const handle = app.fetch;

  const server = serve({ fetch: handle, port, hostname });

  return async () => {
    await new Promise<void>((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()));
    });
  };
}

// ---- helpers -----------------------------------------------------------

function resolveWebDir(): string {
  // Resolve apps/web from the CLI's installed location. This file at runtime
  // sits in apps/cli/dist; from there `../../web` walks up to the workspace
  // root's apps/web.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, ROOT_RELATIVE_WEB_DIR);
}

async function acquireOrReplaceLock(config: Config, options: StartOptions): Promise<DaemonLock> {
  const info = {
    pid: process.pid,
    port: config.daemon.port,
    hostname: config.daemon.hostname,
    startedAt: new Date().toISOString(),
    version: DAEMON_VERSION,
  };

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
