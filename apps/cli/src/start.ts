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
import { type Config, type Project, type Runtime, WatcherService, buildRuntime } from "@loctx/core";

export interface StartOptions {
  readonly port: number;
  readonly hostname?: string;
  readonly enableWatch: boolean;
  readonly enableWeb: boolean;
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

const ROOT_RELATIVE_WEB_DIR = "../../../web";

export async function start(config: Config, options: StartOptions): Promise<void> {
  const runtime = await buildRuntime(config);
  const projects = runtime.discovery.discoverProjects();

  if (projects.length === 0) {
    console.error(
      "[loctx start] no projects found under configured workspace_roots; " +
        "the watcher and admin UI will run but stay empty until projects are added.",
    );
  }

  const watchers = options.enableWatch ? await startWatchers(runtime, projects) : [];
  const httpStop = options.enableWeb
    ? await startWeb(options)
    : async () => {
        /* no-op */
      };

  const banner = [
    `[loctx start] runtime ready (${projects.length} projects, ${runtime.config.embedding.model})`,
    options.enableWeb
      ? `[loctx start] admin UI:    http://${options.hostname ?? "localhost"}:${options.port}/`
      : null,
    options.enableWeb
      ? `[loctx start] MCP endpoint: http://${options.hostname ?? "localhost"}:${options.port}/mcp`
      : null,
    options.enableWatch ? `[loctx start] watcher running on ${watchers.length} project(s)` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  console.error(banner);

  await waitForShutdownSignal();
  console.error("\n[loctx start] shutting down...");

  await Promise.allSettled(watchers.map((w) => w.stop()));
  await httpStop();
  runtime.close();
}

// ---- watchers ----------------------------------------------------------

async function startWatchers(
  runtime: Runtime,
  projects: ReadonlyArray<Project>,
): Promise<WatcherService[]> {
  const watchers: WatcherService[] = [];
  for (const project of projects) {
    const w = new WatcherService(project, runtime.indexer, {
      onEvent: (event, relPath) => {
        console.error(`[loctx watch] ${event}\t${project.name}/${relPath}`);
      },
    });
    await w.start();
    watchers.push(w);
  }
  return watchers;
}

// ---- web ---------------------------------------------------------------

async function startWeb(options: StartOptions): Promise<() => Promise<void>> {
  const webDir = options.webDir ?? resolveWebDir();
  const port = options.port;
  const hostname = options.hostname ?? "localhost";

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

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
