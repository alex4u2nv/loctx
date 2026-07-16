/**
 * reconcilingState (#453) — the tri-state behind IndexHealth.reconciling.
 * The stdio MCP server never loops a reconciler, so a plain `false` was a
 * lie whenever a separate `loctx start` daemon was mid-reindex. This
 * distinguishes "I own the reconciler and it's idle" (authoritative
 * false) from "another daemon owns it; I can't see" ("unknown").
 */

import { describe, expect, it } from "vitest";
import { reconcilingState } from "../src/registry.js";

const SELF = 4242;

describe("reconcilingState (#453)", () => {
  it("reports true when this process's reconciler is running", () => {
    expect(reconcilingState(true, null, SELF)).toBe(true);
    // Running wins even if a foreign daemon also holds the lock.
    expect(reconcilingState(true, { pid: 99 }, SELF)).toBe(true);
  });

  it("reports false when idle and no daemon holds the lock (authoritative)", () => {
    expect(reconcilingState(false, null, SELF)).toBe(false);
  });

  it("reports false when idle and THIS process owns the daemon lock", () => {
    // The daemon process itself: its reconciler is authoritative even when idle.
    expect(reconcilingState(false, { pid: SELF }, SELF)).toBe(false);
  });

  it("reports 'unknown' when idle but another live daemon owns reconciliation", () => {
    // The stdio server alongside a running daemon: can't see the daemon's
    // in-memory reconcile progress, so don't claim the index is settled.
    expect(reconcilingState(false, { pid: 99 }, SELF)).toBe("unknown");
  });
});
