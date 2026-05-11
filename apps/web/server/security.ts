/**
 * Local-daemon hardening middleware: Host + Origin validation.
 *
 * loctx is a single-user, no-auth, localhost-bound daemon. Without
 * these checks the daemon is reachable from any webpage the user
 * visits — CSRF for state-changing endpoints, plus DNS-rebinding
 * exposure for the response body (search results, config).
 *
 * What this enforces:
 *
 *   1. **Host** must be one of the addresses we deliberately bind to
 *      (configured hostname + the loopback aliases on the same port).
 *      Stops DNS-rebinding because the rebound request still carries
 *      the attacker's Host name in the header.
 *
 *   2. **Origin**, when present, must point at the same daemon URL.
 *      Absent Origin means non-browser caller (curl, MCP stdio bridge,
 *      same-page same-origin fetch on some Chromium versions) — allow.
 *      Present-but-mismatched Origin means cross-origin browser fetch —
 *      reject before the side-effect runs.
 *
 * Static assets (`/assets/*`, `/`, the SPA fallback) are intentionally
 * NOT gated — they're public bundles. Only `/api/*` and `/mcp` carry
 * sensitive surface.
 */

import type { Context, MiddlewareHandler } from "hono";

export interface SecurityMiddlewareOptions {
  readonly hostname: string;
  readonly port: number;
}

export function localDaemonGuard(opts: SecurityMiddlewareOptions): MiddlewareHandler {
  const allowedHosts = new Set<string>([
    `${opts.hostname}:${opts.port}`,
    `127.0.0.1:${opts.port}`,
    `[::1]:${opts.port}`,
    `localhost:${opts.port}`,
  ]);
  const allowedOrigins = new Set<string>([
    `http://${opts.hostname}:${opts.port}`,
    `http://127.0.0.1:${opts.port}`,
    `http://[::1]:${opts.port}`,
    `http://localhost:${opts.port}`,
  ]);

  return async (c: Context, next) => {
    if (!isProtectedPath(c.req.path)) return next();

    const host = c.req.header("host") ?? "";
    if (!allowedHosts.has(host.toLowerCase())) {
      return c.text(`forbidden: unexpected Host header ${host}`, 403);
    }

    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== "" && origin !== "null") {
      if (!allowedOrigins.has(origin.toLowerCase())) {
        return c.text(`forbidden: unexpected Origin ${origin}`, 403);
      }
    }

    return next();
  };
}

/**
 * Paths that carry sensitive surface. Keep the prefix list tight so
 * future routes inherit the guard automatically only when they sit
 * under `/api` or `/mcp`. Static assets, the SPA index, and arbitrary
 * GETs that hit the SPA fallback are explicitly out of scope (they
 * carry no data the attacker can't already mint themselves).
 */
function isProtectedPath(path: string): boolean {
  return path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/api/");
}
