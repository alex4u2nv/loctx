/**
 * request-validation.ts — the daemon's body-parse + error-sanitize
 * layer. These are the guards that keep a malformed loopback request
 * from slipping a string into a numeric field, pushing `limit: 1e9`
 * past the bounds, or leaking stack-derived internals to the caller.
 * Every branch is exercised here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseBool,
  parseInt as parseBoundedInt,
  parseString,
  sanitizeError,
} from "../../server/lib/request-validation.js";

describe("parseInt (bounded)", () => {
  const opts = { min: 1, max: 100, default: 10 };

  it("returns the default when the field is absent", () => {
    expect(parseBoundedInt(undefined, opts)).toBe(10);
  });

  it("returns the value when in range", () => {
    expect(parseBoundedInt(42, opts)).toBe(42);
  });

  it("accepts the inclusive bounds", () => {
    expect(parseBoundedInt(1, opts)).toBe(1);
    expect(parseBoundedInt(100, opts)).toBe(100);
  });

  it("truncates a fractional number before the range check", () => {
    expect(parseBoundedInt(42.9, opts)).toBe(42);
  });

  it("rejects out-of-range values with null", () => {
    expect(parseBoundedInt(0, opts)).toBeNull();
    expect(parseBoundedInt(101, opts)).toBeNull();
  });

  it("rejects non-numbers and non-finite numbers with null", () => {
    expect(parseBoundedInt("5", opts)).toBeNull();
    expect(parseBoundedInt(true, opts)).toBeNull();
    expect(parseBoundedInt(Number.POSITIVE_INFINITY, opts)).toBeNull();
    expect(parseBoundedInt(Number.NaN, opts)).toBeNull();
    expect(parseBoundedInt(null, opts)).toBeNull();
  });
});

describe("parseString", () => {
  it("returns null when the field is absent", () => {
    expect(parseString(undefined)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseString("  hi  ")).toBe("hi");
  });

  it("returns an empty string for whitespace-only input (caller decides significance)", () => {
    expect(parseString("   ")).toBe("");
  });

  it("rejects non-strings with null", () => {
    expect(parseString(5)).toBeNull();
    expect(parseString(true)).toBeNull();
    expect(parseString(null)).toBeNull();
    expect(parseString({})).toBeNull();
  });

  it("enforces maxLength against the trimmed length", () => {
    expect(parseString("abc", { maxLength: 3 })).toBe("abc");
    expect(parseString("abcd", { maxLength: 3 })).toBeNull();
    // Trimmed to length 3 → within the bound even though raw length is 7.
    expect(parseString("  abc  ", { maxLength: 3 })).toBe("abc");
  });
});

describe("parseBool", () => {
  it("returns undefined when the field is absent (distinct from a false value)", () => {
    expect(parseBool(undefined)).toBeUndefined();
  });

  it("passes through real booleans", () => {
    expect(parseBool(true)).toBe(true);
    expect(parseBool(false)).toBe(false);
  });

  it("rejects non-booleans with null", () => {
    expect(parseBool("true")).toBeNull();
    expect(parseBool(1)).toBeNull();
    expect(parseBool(null)).toBeNull();
  });
});

describe("sanitizeError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an opaque shape and never leaks the raw message to the client", () => {
    const out = sanitizeError("search", new Error("/Users/alex/secret/path exploded"));
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
