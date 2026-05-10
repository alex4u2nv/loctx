/**
 * Tests for ulimit helpers — focused on the gating logic of
 * maybeRespawnWithRaisedNofile. We don't try to actually respawn the
 * test process; we set state that proves the function returns early
 * without entering the spawnSync path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NOFILE_RESPAWN_ENV,
  RECOMMENDED_NOFILE,
  maybeRespawnWithRaisedNofile,
  raiseNofile,
  readNofile,
} from "../../src/ulimit.js";

describe("ulimit.readNofile", () => {
  it("returns a number on Unix-like platforms (or null on Windows)", () => {
    const n = readNofile();
    if (process.platform === "win32") {
      // Windows has no rlimit model — null is the contract.
      expect(n).toBeNull();
    } else {
      expect(typeof n).toBe("number");
      expect(n).toBeGreaterThan(0);
    }
  });
});

describe("ulimit.raiseNofile", () => {
  it("returns null when process.setrlimit is unavailable", () => {
    // Node 25 doesn't expose setrlimit; raiseNofile signals unavailability
    // by returning null rather than pretending to succeed. Future Node
    // releases that ship setrlimit will make this a no-op + raise instead.
    const proc = process as unknown as { setrlimit?: unknown };
    if (typeof proc.setrlimit !== "function") {
      expect(raiseNofile()).toBeNull();
    } else {
      const result = raiseNofile(RECOMMENDED_NOFILE);
      expect(result).not.toBeNull();
    }
  });
});

describe("ulimit.maybeRespawnWithRaisedNofile", () => {
  let originalMarker: string | undefined;

  beforeEach(() => {
    originalMarker = process.env[NOFILE_RESPAWN_ENV];
  });
  afterEach(() => {
    if (originalMarker === undefined) delete process.env[NOFILE_RESPAWN_ENV];
    else process.env[NOFILE_RESPAWN_ENV] = originalMarker;
  });

  it("no-ops when the respawn marker is already set (loop guard)", () => {
    process.env[NOFILE_RESPAWN_ENV] = "1";
    // Returns void; if the function tried to spawn we'd see test-runner
    // weirdness. The real assertion: control returns to us.
    expect(() => maybeRespawnWithRaisedNofile(RECOMMENDED_NOFILE)).not.toThrow();
  });

  it("no-ops when the current limit is already at or above target", () => {
    delete process.env[NOFILE_RESPAWN_ENV];
    const current = readNofile() ?? 0;
    if (current === 0) return; // platform without rlimit (e.g., Windows CI)
    // Pass a target lower than the current soft limit — function should
    // see "already satisfied" and return without spawning.
    expect(() => maybeRespawnWithRaisedNofile(Math.max(1, current - 1))).not.toThrow();
  });
});
