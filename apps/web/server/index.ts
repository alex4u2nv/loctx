/**
 * Hono application factory for the loctx admin UI + MCP HTTP transport.
 *
 * The CLI's `loctx start` calls `createWebApp({ config, runtime, staticDir })`
 * to get an app it can mount on `daemon.port` via @hono/node-server. The
 * full Runtime (embeddings + LanceDB) is built lazily on first /search or
 * /mcp request to keep cold start cheap.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  type Runtime,
  type WatcherRegistry,
  buildRuntime,
  loadConfig,
} from "@loctx/core";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { mountApi } from "./api/index.js";
import { mountMcp } from "./mcp.js";

export interface CreateWebAppOptions {
  /** Frozen config snapshot. The same instance the daemon was started with. */
  readonly config: Config;
  /**
   * Pre-built runtime. When provided, /search and /mcp share it with the
   * watcher + indexer. When omitted, we lazy-build on first need (used by
   * test harnesses that don't carry a daemon).
   */
  readonly runtime?: Runtime;
  /**
   * Watcher registry from the daemon. When omitted, watcher endpoints
   * report an empty list and refuse pause/resume — the daemon was
   * started with --no-watch.
   */
  readonly watcherRegistry?: WatcherRegistry;
  /**
   * Absolute path to the built SPA directory (`dist/client`). When set, we
   * serve static files and SPA fallback. When omitted, only /api and /mcp
   * are mounted — useful in dev where Vite handles the client.
   */
  readonly staticDir?: string;
}

export function createWebApp(opts: CreateWebAppOptions): Hono {
  const app = new Hono();

  // Lazy runtime: prebuilt one wins; otherwise build on first need and
  // memoise. `buildRuntime` is heavy (embedding model load) so /status,
  // /projects, /events deliberately don't trigger it.
  let lazyRuntime: Promise<Runtime> | null = null;
  const getRuntime = (): Promise<Runtime> => {
    if (opts.runtime !== undefined) return Promise.resolve(opts.runtime);
    if (lazyRuntime === null) lazyRuntime = buildRuntime(loadConfig());
    return lazyRuntime;
  };

  mountApi(app, opts.config, getRuntime, opts.watcherRegistry);
  mountMcp(app, getRuntime);

  if (opts.staticDir !== undefined && existsSync(opts.staticDir)) {
    const root = opts.staticDir;
    app.use(
      "/*",
      serveStatic({
        root,
        rewriteRequestPath: (path) => path,
      }),
    );
    // SPA fallback: any unmatched GET that didn't hit /api or /mcp gets
    // index.html so client-side routing works on hard reloads.
    app.get("*", async (c) => {
      const indexHtml = join(root, "index.html");
      const { readFileSync } = await import("node:fs");
      try {
        return c.html(readFileSync(indexHtml, "utf-8"));
      } catch {
        return c.text("client bundle missing", 503);
      }
    });
  }

  return app;
}
