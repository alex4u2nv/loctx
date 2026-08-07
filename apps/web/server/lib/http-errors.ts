/**
 * One error boundary for the whole HTTP surface (SRV-3).
 *
 * Before this module each route hand-rolled its own JSON-parse guard
 * (8 copies, 3 incompatible response shapes) and only 2 of ~30
 * handlers were wired to `sanitizeError` — an uncaught throw anywhere
 * else fell through to Hono's default text/plain 500 with the raw
 * error message, leaking stack-derived paths to the caller.
 *
 * The model now:
 *
 *   - Handlers (and shared helpers like `confinedPath`) throw
 *     {@link HttpError} subclasses for expected wire failures. The
 *     `app.onError` boundary maps them to `{ error: message }` with
 *     the carried status.
 *   - Anything else that escapes a handler is sanitized: opaque
 *     `{ error: "internal_error", code: "unhandled" }` on the wire,
 *     full detail on stderr for the operator.
 *   - {@link jsonBody} is the single JSON-parse guard: a malformed or
 *     non-object body throws a 400 `{ error: "invalid JSON body" }`.
 */

import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { sanitizeError } from "./request-validation.js";

/** Expected wire failure: `message` is safe to show the caller as-is. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message);
  }
}

/**
 * Parse the request's JSON body, insisting on a JSON object. Malformed
 * JSON, an empty body, and non-object payloads (arrays, numbers,
 * `null`) all map to the uniform 400 via the error boundary.
 */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequestError("invalid JSON body");
  }
  return requireJsonObject(raw);
}

/**
 * Like {@link jsonBody}, but an empty/whitespace body parses as `{}`.
 * For trigger-style endpoints (`/api/index`, `/api/rebuild`) where a
 * body-less POST means "run against everything" — that convention
 * predates the SRV-3 unification and existing callers (curl, scripts)
 * must keep working. Genuinely malformed JSON still 400s.
 */
export async function jsonBodyOrEmpty(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequestError("invalid JSON body");
  }
  return requireJsonObject(raw);
}

function requireJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadRequestError("invalid JSON body");
  }
  return raw as Record<string, unknown>;
}

/**
 * Install the app-level error boundary. Registered by `createWebApp`
 * and by the unit-test harness so route tests exercise the same
 * mapping production gets.
 */
export function registerErrorBoundary(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json(sanitizeError("unhandled", err, "see daemon logs for details"), 500);
  });
}
