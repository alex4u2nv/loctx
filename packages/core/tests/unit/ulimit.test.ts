/**
 * Sanity coverage for the fd-exhaustion heuristic. The string forms
 * we match here are what we've actually seen surface from @parcel/watcher
 * across platforms; if the heuristic regresses, watcher boot failures
 * stop being annotated with the recovery hint and users are left
 * staring at a bare "EMFILE" without context.
 */

import { describe, expect, it } from "vitest";
import { looksLikeFdExhaustion, nofileBumpHint } from "../../src/ulimit.js";

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

describe("nofileBumpHint", () => {
  it("returns a multi-line hint mentioning ulimit -n", () => {
    const hint = nofileBumpHint();
    expect(hint).toContain("ulimit -n");
    expect(hint.split("\n").length).toBeGreaterThan(1);
  });
});
