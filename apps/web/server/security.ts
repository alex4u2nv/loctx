/**
 * Local-daemon hardening middleware: Host + Origin validation + CORS
 * preflight.
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
 *   3. **OPTIONS preflight** for protected paths is answered here. The
 *      same Host/Origin checks gate the response; on success we emit
 *      the standard CORS allow headers so a browser-issued non-simple
 *      request (POST + JSON body) actually fires. Without this, the
 *      preflight 404s and the real request never leaves the browser.
 *      Same-origin requests don't preflight, so this is purely for
 *      cross-tab scenarios (e.g. an embedded loctx widget).
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

const PREFLIGHT_MAX_AGE_S = 600;
const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Accept, Authorization";

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
    const originValue =
      origin !== undefined && origin !== "" && origin !== "null" ? origin : null;
    if (originValue !== null && !allowedOrigins.has(originValue.toLowerCase())) {
      return c.text(`forbidden: unexpected Origin ${originValue}`, 403);
    }

    // CORS preflight: same allowlist as the real request, plus the
    // canonical headers a non-simple POST needs. We echo the validated
    // Origin (not "*") so credentials-mode requests work and we don't
    // accidentally widen the allowlist.
    if (c.req.method === "OPTIONS" && originValue !== null) {
      c.header("Access-Control-Allow-Origin", originValue);
      c.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
      c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      c.header("Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_S));
      c.header("Vary", "Origin");
      return c.body(null, 204);
    }

    // Non-preflight cross-origin response also needs Allow-Origin /
    // Vary so the browser exposes the body to the caller's JS. For
    // same-origin (originValue null) this is unnecessary noise; skip.
    if (originValue !== null) {
      c.header("Access-Control-Allow-Origin", originValue);
      c.header("Vary", "Origin");
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
