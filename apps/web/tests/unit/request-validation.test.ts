/**
 * request-validation.ts — the daemon's error-sanitize layer: the guard
 * that keeps stack-derived internals out of client responses. The
 * body-field validators that used to live alongside it moved to
 * @loctx/core's shared tool-input specs (SRV-5) and are exercised in
 * packages/core/tests/unit/tool_inputs.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeError } from "../../server/lib/request-validation.js";

describe("sanitizeError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an opaque shape and never leaks the raw message to the client", () => {
    const out = sanitizeError("search", new Error("/Users/you/secret/path exploded"));
    expect(out).toEqual({ error: "internal_error", code: "search" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("logs the full detail to stderr for operators", () => {
    const spy = vi.spyOn(console, "error");
    sanitizeError("cfg", new Error("boom detail"));
    expect(spy).toHaveBeenCalledWith("[api:cfg] boom detail");
  });

  it("stringifies non-Error throwables for the log", () => {
    const spy = vi.spyOn(console, "error");
    sanitizeError("x", "plain string failure");
    expect(spy).toHaveBeenCalledWith("[api:x] plain string failure");
  });

  it("includes the hint only when supplied", () => {
    expect(sanitizeError("a", new Error("e"))).not.toHaveProperty("hint");
    expect(sanitizeError("a", new Error("e"), "try again")).toMatchObject({
      hint: "try again",
    });
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(sanitizeError("a", new Error("e")))).toBe(true);
  });
});
