/**
 * Error plumbing shared across the eval harness.
 */

/**
 * Message text for an arbitrary thrown value. Replaces the
 * `(err as Error).message` casts (CLI-10, 2026-08-06 audit): a
 * non-Error throw (string, plain object) used to print
 * `failed: undefined` in exactly the diagnostic paths where the
 * message mattered.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
