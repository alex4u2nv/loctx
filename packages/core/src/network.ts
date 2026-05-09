/**
 * Outbound-network gate. loctx is local-first; the only legitimate
 * outbound use is downloading an embedding model from Hugging Face,
 * and even that should happen only when the user explicitly asks.
 *
 * The guard is a per-process allowlist: code that intends to make an
 * outbound request must declare its `OutboundReason`. Code that
 * doesn't go through `requireOutboundAllowed` is opting out of the
 * gate; the audit story is "grep for `requireOutboundAllowed` and
 * confirm every match is a known callsite." We deliberately don't
 * monkey-patch global fetch because that adds fragility for negligible
 * benefit — the third-party libraries we depend on (HF transformers,
 * Next.js) aren't supposed to make calls without our knowledge.
 *
 * Default state: empty allowlist. CLI commands that need outbound
 * (model download, init wizard's optional download) flip the allowlist
 * before invoking code that would call out.
 */

export type OutboundReason = "model-download";

let allowedReasons: ReadonlySet<OutboundReason> = Object.freeze(new Set<OutboundReason>());

/**
 * Replace the per-process outbound allowlist. Pass an empty iterable to
 * lock down again. Idempotent.
 */
export function setAllowedOutboundReasons(reasons: Iterable<OutboundReason>): void {
  allowedReasons = Object.freeze(new Set(reasons));
}

/**
 * Throw {@link NetworkBlockedError} if `reason` is not currently allowed.
 * Call this immediately before any code path that would issue an HTTP
 * request, so users see a clear error message instead of an opaque
 * library failure.
 */
export function requireOutboundAllowed(reason: OutboundReason): void {
  if (!allowedReasons.has(reason)) {
    throw new NetworkBlockedError(
      `Outbound network access for "${reason}" is blocked by loctx's local-first default. Run \`loctx model download <name>\` to fetch an embedding model, then re-run this command.`,
    );
  }
}

export class NetworkBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkBlockedError";
  }
}
