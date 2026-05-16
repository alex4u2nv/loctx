/**
 * Request body / response sanitization helpers.
 *
 * Two concerns this module owns:
 *
 *   1. Strict body validation for the POST surface. Each endpoint
 *      parses optional fields with `parseString` / `parseInt` /
 *      `parseBool` so a malformed request can't slip a string into a
 *      numeric field or a `limit: 1e9` past the bounds — both ways the
 *      handler would degrade (huge payloads, expensive scans).
 *
 *   2. Error-response sanitization. Raw `(err as Error).message`
 *      leaks stack-derived paths, embedded chunk content, and other
 *      internals to the client. `sanitizeError` returns a small
 *      machine-readable shape AND logs the full detail to stderr so
 *      operators can debug.
 *
 * Both target the daemon-on-loopback threat model: even though we're
 * not exposed to the internet, every process on the local machine can
 * reach us through the CSRF-protected port. Tight inputs + opaque
 * errors are belt-and-suspenders for the path-confinement and
 * Host/Origin guards.
 */

export interface SanitizedError {
  readonly error: string;
  readonly code: string;
  /** Short, opaque user-facing message. Stack-derived details stay in the log. */
  readonly hint?: string;
}

/** Generic error-response builder. Logs the full error to stderr. */
export function sanitizeError(
  label: string,
  err: unknown,
  hint?: string,
): SanitizedError {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api:${label}] ${message}`);
  return Object.freeze({
    error: "internal_error",
    code: label,
    ...(hint !== undefined ? { hint } : {}),
  });
}

/** Bounded integer parse. Returns the default when input is missing, the value when in range, or null on type/range violation. */
export function parseInt(
  raw: unknown,
  opts: { min: number; max: number; default: number },
): number | null {
  if (raw === undefined) return opts.default;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  if (n < opts.min || n > opts.max) return null;
  return n;
}

/** Trimmed string parse. Returns null on type violation. */
export function parseString(
  raw: unknown,
  opts: { maxLength?: number } = {},
): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (opts.maxLength !== undefined && trimmed.length > opts.maxLength) return null;
  return trimmed;
}

/** Boolean parse. Returns null on type violation, undefined-as-undefined. */
export function parseBool(raw: unknown): boolean | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") return null;
  return raw;
}
