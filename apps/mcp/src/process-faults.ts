/**
 * Process-fault tracker for the long-lived stdio MCP server (#452).
 *
 * The server swallows `unhandledRejection` / `uncaughtException` so a
 * stray background rejection (or cross-process DB contention while the
 * daemon writes) doesn't crash the session. Swallowing keeps the server
 * alive but made genuine bugs invisible: they reached stderr only, which
 * agent clients rarely surface, and a persistent fault looked identical
 * to silence.
 *
 * This tracker makes the swallow observable:
 *   - dedupes by signature (kind + first line) so a tight fault loop
 *     doesn't spam stderr — logs the first occurrence, then at most once
 *     per rate-limit window per signature;
 *   - counts every fault (total + per-signature) since boot;
 *   - exposes a snapshot the `workspace_status` tool surfaces, so a
 *     client can see "this server has swallowed N faults" without
 *     reading the daemon's stderr.
 */

export type ProcessFaultKind = "unhandledRejection" | "uncaughtException";

export interface ProcessFaultEntry {
  /** `kind:first-line-of-detail` — the dedup key. */
  readonly signature: string;
  readonly kind: ProcessFaultKind;
  readonly count: number;
  /** Most recent full detail (stack or message) for this signature. */
  readonly lastDetail: string;
  readonly lastAt: string;
}

export interface ProcessFaultSnapshot {
  /** Every fault recorded since boot, across all signatures. */
  readonly total: number;
  /** Distinct fault signatures. */
  readonly unique: number;
  readonly lastAt: string | null;
  /** Most-recent-first, capped at {@link ProcessFaultTracker}'s window. */
  readonly recent: ReadonlyArray<ProcessFaultEntry>;
}

const DEFAULT_RATE_LIMIT_MS = 60_000;
const DEFAULT_MAX_SIGNATURES = 50;

interface Record {
  kind: ProcessFaultKind;
  count: number;
  lastDetail: string;
  lastAt: number;
  lastLoggedAt: number;
}

export class ProcessFaultTracker {
  private total = 0;
  private readonly bySig = new Map<string, Record>();
  private readonly now: () => number;
  private readonly rateLimitMs: number;
  private readonly maxSignatures: number;

  constructor(options: { now?: () => number; rateLimitMs?: number; maxSignatures?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.maxSignatures = options.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
  }

  /**
   * Record a swallowed fault. Returns true when the caller should log
   * this occurrence to stderr (first sighting of the signature, or the
   * rate-limit window since the last log has elapsed), false when it
   * should be suppressed as a duplicate.
   */
  record(kind: ProcessFaultKind, detail: string): boolean {
    const at = this.now();
    this.total += 1;
    const signature = `${kind}:${firstLine(detail)}`;
    const existing = this.bySig.get(signature);
    if (existing === undefined) {
      this.bySig.set(signature, {
        kind,
        count: 1,
        lastDetail: detail,
        lastAt: at,
        lastLoggedAt: at,
      });
      this.evictIfNeeded();
      return true; // first sighting always logs
    }
    existing.count += 1;
    existing.lastDetail = detail;
    existing.lastAt = at;
    // Re-insert to keep Map insertion order = recency for eviction.
    this.bySig.delete(signature);
    this.bySig.set(signature, existing);
    if (at - existing.lastLoggedAt >= this.rateLimitMs) {
      existing.lastLoggedAt = at;
      return true;
    }
    return false;
  }

  snapshot(): ProcessFaultSnapshot {
    const entries = [...this.bySig.entries()]
      .map(
        ([signature, r]): ProcessFaultEntry => ({
          signature,
          kind: r.kind,
          count: r.count,
          lastDetail: r.lastDetail,
          lastAt: new Date(r.lastAt).toISOString(),
        }),
      )
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return Object.freeze({
      total: this.total,
      unique: this.bySig.size,
      lastAt: entries[0]?.lastAt ?? null,
      recent: Object.freeze(entries),
    });
  }

  private evictIfNeeded(): void {
    while (this.bySig.size > this.maxSignatures) {
      // Map preserves insertion order; the first key is the oldest.
      const oldest = this.bySig.keys().next().value;
      if (oldest === undefined) break;
      this.bySig.delete(oldest);
    }
  }
}

function firstLine(detail: string): string {
  const nl = detail.indexOf("\n");
  return (nl === -1 ? detail : detail.slice(0, nl)).trim();
}
