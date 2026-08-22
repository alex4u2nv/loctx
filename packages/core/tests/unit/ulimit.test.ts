/**
 * Sanity coverage for the fd-exhaustion heuristic. The string forms
 * we match here are what we've actually seen surface from @parcel/watcher
 * across platforms; if the heuristic regresses, watcher boot failures
 * stop being annotated with the recovery hint and users are left
 * staring at a bare "EMFILE" without context.
 */

import { describe, expect, it } from "vitest";
import {
  isHardLimitBound,
  looksLikeFdExhaustion,
  type NofileStatus,
  nofileBumpHint,
} from "../../src/ulimit.js";

const status = (current: number, hard: number, recommended = 4096): NofileStatus =>
  Object.freeze({ current, hard, recommended, ok: current >= recommended });

describe("looksLikeFdExhaustion", () => {
  it("matches macOS EMFILE", () => {
    expect(looksLikeFdExhaustion("EMFILE: too many open files, watch")).toBe(true);
  });

  it("matches the Linux inotify limit ENOSPC form", () => {
    expect(
      looksLikeFdExhaustion("ENOSPC: System limit for number of file watchers reached, watch"),
    ).toBe(true);
  });

  it("matches the prose form parcel sometimes surfaces", () => {
    expect(looksLikeFdExhaustion("watch error: too many open files")).toBe(true);
  });

  it("matches the explicit max_user_watches form", () => {
    expect(looksLikeFdExhaustion("inotify: max_user_watches=8192 reached")).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(looksLikeFdExhaustion("EACCES: permission denied")).toBe(false);
    expect(looksLikeFdExhaustion("Could not parse YAML")).toBe(false);
    expect(looksLikeFdExhaustion("")).toBe(false);
  });
});

describe("isHardLimitBound", () => {
  it("true when the hard cap sits below the recommended floor", () => {
    expect(isHardLimitBound(status(256, 256))).toBe(true);
  });

  it("false when only the soft limit is low", () => {
    expect(isHardLimitBound(status(256, 10240))).toBe(false);
  });

  it("false for an unlimited hard cap", () => {
    expect(isHardLimitBound(status(256, Number.POSITIVE_INFINITY))).toBe(false);
  });
});

describe("nofileBumpHint", () => {
  it("returns a multi-line hint mentioning ulimit -n", () => {
    const hint = nofileBumpHint();
    expect(hint).toContain("ulimit -n");
    expect(hint.split("\n").length).toBeGreaterThan(1);
  });

  it("darwin + hard-bound: leads with the launchctl route (#560)", () => {
    // `ulimit -n` cannot exceed the hard cap, so plain ulimit advice is
    // a dead end — the hint must say launchctl + re-login is required.
    const hint = nofileBumpHint(status(256, 256), "darwin");
    expect(hint).toContain("launchctl limit maxfiles");
    expect(hint).toContain("log out and back in");
  });

  it("darwin with soft-only shortfall: plain ulimit advice suffices", () => {
    const hint = nofileBumpHint(status(256, 10240), "darwin");
    expect(hint).toContain("ulimit -n 10240");
    expect(hint).not.toContain("launchctl");
  });

  it("linux: includes the inotify watch-limit escape hatch", () => {
    const hint = nofileBumpHint(status(256, 10240), "linux");
    expect(hint).toContain("fs.inotify.max_user_watches");
  });
});
