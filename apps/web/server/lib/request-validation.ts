/**
 * Error-response sanitization.
 *
 * Raw `(err as Error).message` leaks stack-derived paths, embedded
 * chunk content, and other internals to the client. `sanitizeError`
 * returns a small machine-readable shape AND logs the full detail to
 * stderr so operators can debug.
 *
 * Targets the daemon-on-loopback threat model: even though we're not
 * exposed to the internet, every process on the local machine can
 * reach us through the CSRF-protected port. Opaque errors are
 * belt-and-suspenders for the path-confinement and Host/Origin guards.
 *
 * Body-field validation used to live here too; the shared per-operation
 * input specs moved to @loctx/core (`tool-inputs.ts`, SRV-5) so the MCP
 * transport enforces the identical bounds.
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
