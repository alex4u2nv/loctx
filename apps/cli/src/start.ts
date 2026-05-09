/**
 * Integrated daemon orchestrator.
 *
 * Launches in one process:
 *   1. Build the runtime (StateStore, VectorStore, embeddings, indexer).
 *   2. Start a chokidar watcher per discovered project (unless --no-watch).
 *   3. Boot Next.js programmatically and serve the admin UI + the /mcp
 *      route on the same port (unless --no-web).
 *
 * Graceful shutdown: SIGINT / SIGTERM stops watchers, closes the HTTP
 * server, then closes the StateStore.
 */

import { createServer } from "node:http";
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
  stopActiveDaemon,
} from "@loctx/core";

const DAEMON_VERSION = "0.1.0";

export interface StartOptions {
  readonly enableWatch: boolean;
  readonly enableWeb: boolean;
  readonly replace: boolean; // if true, terminate any existing daemon first
  readonly webDir?: string;
}

interface NextLikeApp {
  prepare(): Promise<void>;
  getRequestHandler(): (req: unknown, res: unknown) => Promise<void>;
  close?(): Promise<void>;
}

type NextFactory = (config: {
  dev: boolean;
  dir: string;
  hostname?: string;
  port?: number;
}) => NextLikeApp;

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

  const watchers = options.enableWatch ? await startWatchers(runtime, projects, config) : [];
  const httpStop = options.enableWeb
    ? await startWeb(config, options)
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

async function startWeb(config: Config, options: StartOptions): Promise<() => Promise<void>> {
  const webDir = options.webDir ?? resolveWebDir();
  const { port, hostname } = config.daemon;

  // Lazy: pulls in next + react. Not needed when --no-web.
  const moduleName = "next";
  const next = (await import(moduleName)) as { default: NextFactory } | NextFactory;
  const factory = "default" in next ? next.default : next;

  const app = factory({ dev: false, dir: webDir, hostname, port });
  await app.prepare();
  const handler = app.getRequestHandler();

  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err: unknown) => {
      console.error(`[loctx start] request handler error: ${(err as Error).message}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });

  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (typeof app.close === "function") await app.close();
  };
}

// ---- helpers -----------------------------------------------------------

function resolveWebDir(): string {
  // Resolve apps/web from the CLI's installed location. This file at runtime
  // sits in apps/cli/dist; from there `../web` is wrong, but `../../web` is
  // also wrong because we want the workspace root's apps/web. Walk up until
  // we find apps/web/package.json with name @loctx/web.
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
