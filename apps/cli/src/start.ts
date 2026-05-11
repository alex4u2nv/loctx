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
  WatcherService,
  acquireDaemonLock,
  buildRuntime,
  checkNofile,
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

  const projects = runtime.discovery.discoverProjects();

  if (projects.length === 0) {
    console.error(
      "[loctx start] no projects found under configured workspace_roots; " +
        "the watcher and admin UI will run but stay empty until projects are added.",
    );
  }

  if (options.enableWatch) warnIfNofileLow(projects.length);

  const watchers = options.enableWatch ? await startWatchers(runtime, projects, config) : [];

  // Reconciliation (#14): catch up after the daemon was offline. We kick
  // off boot reconciliation in the background so the HTTP / MCP surface
  // doesn't wait on a long full-corpus walk; the watcher is already
  // catching live events. The periodic timer drifts indefinitely until
  // shutdown.
  const reconciliationStop = startReconciliation(runtime, projects, config);
  const httpStop = options.enableWeb
    ? await startWeb(config, options, runtime)
    : async () => {
        /* no-op */
      };

  const banner = [
    `[loctx start] runtime ready (${projects.length} projects, ${runtime.config.embedding.model})`,
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
      })
      .catch((err) => {
        console.error(`[loctx reconcile] ${label} failed: ${(err as Error).message}`);
      });
  };

  if (runOnStart) {
    setImmediate(() => run("startup"));
  }

  if (intervalSeconds > 0) {
    const timer = setInterval(() => run("periodic"), intervalSeconds * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }
  return () => undefined;
}

// ---- preflight ---------------------------------------------------------

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
): Promise<WatcherService[]> {
  return Promise.all(
    projects.map(async (project) => {
      const w = new WatcherService(project, runtime.indexer, {
        debounceMs: config.watcher.debounceMs,
        onEvent: (event, relPath) => {
          console.error(`[loctx watch] ${event}\t${project.name}/${relPath}`);
        },
      });
      await w.start();
      return w;
    }),
  );
}

// ---- web ---------------------------------------------------------------

async function startWeb(
  config: Config,
  options: StartOptions,
  runtime: Runtime,
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

  const app = createWebApp({ config, runtime, staticDir });
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
