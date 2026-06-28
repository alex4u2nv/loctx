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
import { localDaemonGuard } from "./security.js";

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
  /**
   * Called after a successful `POST /api/config/write`. The daemon uses
   * this to hot-reload the YAML from disk into its live config object so
   * the change takes effect (and `/api/config` reflects it) without a
   * restart. Omitted by test harnesses, where writes just hit disk.
   */
  readonly onConfigWrite?: () => void | Promise<void>;
}

export function createWebApp(opts: CreateWebAppOptions): Hono {
  const app = new Hono();

  // Local-daemon hardening — Host + Origin gate. MUST be registered
  // before mountApi/mountMcp so it runs before any state-changing
  // handler. Public bundle assets are exempt inside the middleware.
  app.use(
    "*",
    localDaemonGuard({
      hostname: opts.config.daemon.hostname,
      port: opts.config.daemon.port,
    }),
  );

  // Lazy runtime: prebuilt one wins; otherwise build on first need and
  // memoise. `buildRuntime` is heavy (embedding model load) so /status,
  // /projects, /events deliberately don't trigger it.
  //
  // Invariant: once assigned, `lazyRuntime` is NEVER reset, even on a
  // failed buildRuntime promise. A reset-on-error refactor would let
  // two simultaneous early callers each kick off a fresh build,
  // producing two independent VectorStores against the same LanceDB
  // dir — each with its own writer mutex, so the cross-table write
  // ordering from #228 stops holding. The rejected promise sticks
  // around so subsequent callers see the same failure (and the
  // operator gets a consistent error in logs / doctor) until the
  // daemon is restarted. See #189.
  let lazyRuntime: Promise<Runtime> | null = null;
  const getRuntime = (): Promise<Runtime> => {
    if (opts.runtime !== undefined) return Promise.resolve(opts.runtime);
    if (lazyRuntime === null) lazyRuntime = buildRuntime(loadConfig());
    return lazyRuntime;
  };

  mountApi(app, opts.config, getRuntime, opts.watcherRegistry, opts.onConfigWrite);
  mountMcp(app, getRuntime, opts.onConfigWrite);

  // OAuth discovery probes — Claude Code's MCP HTTP client (and others
  // following the MCP spec) GET these well-known paths to detect
  // whether the server requires OAuth before sending `initialize`.
  // loctx is local-first and unauthenticated, so the correct response
  // is a clean 404 JSON. Without this, the SPA fallback returns
  // index.html, the client tries to JSON.parse the HTML, and we get
  // "SDK auth failed: Failed to parse JSON" with no useful diagnostic.
  // Must register BEFORE the SPA fallback below.
  const oauthNotSupported = (c: import("hono").Context) =>
    c.json(
      { error: "not_supported", error_description: "loctx is local-first; no auth required" },
      404,
    );
  app.get("/.well-known/oauth-protected-resource", oauthNotSupported);
  app.get("/.well-known/oauth-protected-resource/mcp", oauthNotSupported);
  app.get("/.well-known/oauth-authorization-server", oauthNotSupported);

  if (opts.staticDir !== undefined && existsSync(opts.staticDir)) {
    const root = opts.staticDir;
    // Cache-control pre-middleware. Without this, non-incognito browsers
    // serve a previously-cached client bundle (heuristic freshness based
    // on Last-Modified) and silently run old code against the latest
    // daemon — symptom: rebuild click hangs because the cached bundle
    // is using removed endpoint semantics. Two rules:
    //
    //   - /assets/<hash>.<ext>  → immutable, year-long. Vite hashes the
    //     filename so the bytes never change for a given URL; revalidation
    //     is pure overhead.
    //   - everything else (index.html, the SPA fallback) → no-cache so
    //     the browser always revalidates and picks up new asset URLs
    //     after a deploy. ETag/Last-Modified still allow a 304.
    app.use("/*", async (c, next) => {
      await next();
      const method = c.req.method;
      if (method !== "GET" && method !== "HEAD") return;
      const path = c.req.path;
      if (path.startsWith("/api/") || path.startsWith("/mcp")) return;
      if (path.startsWith("/assets/")) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        c.header("Cache-Control", "no-cache");
      }
    });
    app.use(
      "/*",
      serveStatic({
        root,
        rewriteRequestPath: (path) => path,
      }),
    );
    // SPA fallback: any unmatched GET that didn't hit /api or /mcp gets
    // index.html so client-side routing works on hard reloads.
    //
    // Exception: requests that look like asset misses (have a file
    // extension, e.g. `/assets/projects-OLDHASH.js`) get a real 404
    // instead of HTML. Returning index.html for a stale chunk hash
    // silently corrupts the browser's `import()` — devtools shows no
    // error but navigation breaks. Surface those misses as a clear
    // network failure so they're diagnosable (#249).
    app.get("*", async (c) => {
      const path = c.req.path;
      if (path.startsWith("/assets/") || /\.[a-zA-Z0-9]+$/.test(path)) {
        return c.text("not found", 404);
      }
      const indexHtml = join(root, "index.html");
      const { readFileSync } = await import("node:fs");
      try {
        return c.html(readFileSync(indexHtml, "utf-8"), 200, {
          "Cache-Control": "no-cache",
        });
      } catch {
        return c.text("client bundle missing", 503);
      }
    });
  }

  return app;
}
