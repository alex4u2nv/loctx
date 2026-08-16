/**
 * The params↔request codecs behind `useUrlQuery` (audit WEB-2). The
 * hook dedupes auto-fires on `encode(decode(params)).toString()`, so
 * the round-trip and canonicalization behavior here is what keeps a
 * submit from double-fetching and keeps deep-links firing exactly once.
 * (The hook itself needs a DOM/router; the client has no jsdom test
 * setup, so only the pure codec layer is covered here.)
 */

import { describe, expect, it } from "vitest";
import {
  findLiteralCodec,
  findUsagesCodec,
  SEARCH_DEFAULT_LIMIT,
  searchCodec,
} from "../../client/lib/query-codecs.js";

describe("searchCodec", () => {
  it("round-trips a fully-specified request", () => {
    const req = { q: "auth token", path: "/repo/src", limit: 25, language: "ts", coverage: true };
    const encoded = searchCodec.encode(req);
    expect(searchCodec.decode(encoded)).toEqual(req);
  });

  it("omits default values on encode (canonical form)", () => {
    const encoded = searchCodec.encode({
      q: "x",
      path: "",
      limit: SEARCH_DEFAULT_LIMIT,
      language: "",
      coverage: false,
    });
    expect(encoded.toString()).toBe("q=x");
  });

  it("canonicalizes an explicit default limit — ?q=x&limit=10 and ?q=x share one auto-fire key", () => {
    const verbose = new URLSearchParams("q=x&limit=10");
    const terse = new URLSearchParams("q=x");
    const keyOf = (p: URLSearchParams): string => {
      const req = searchCodec.decode(p);
      if (req === null) throw new Error("expected fireable");
      return searchCodec.encode(req).toString();
    };
    expect(keyOf(verbose)).toBe(keyOf(terse));
  });

  it("returns null (no auto-fire) for an empty or whitespace query", () => {
    expect(searchCodec.decode(new URLSearchParams(""))).toBeNull();
    expect(searchCodec.decode(new URLSearchParams("q=%20%20&path=/x"))).toBeNull();
  });

  it("falls back to the default limit on unparseable input", () => {
    const req = searchCodec.decode(new URLSearchParams("q=x&limit=banana"));
    expect(req?.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });
});

describe("findLiteralCodec", () => {
  it("round-trips pattern + path", () => {
    const req = { pattern: "agents/foo.md", path: "/repo" };
    expect(findLiteralCodec.decode(findLiteralCodec.encode(req))).toEqual(req);
  });

  it("returns null without a pattern", () => {
    expect(findLiteralCodec.decode(new URLSearchParams("path=/repo"))).toBeNull();
  });

  it("omits an empty path on encode", () => {
    expect(findLiteralCodec.encode({ pattern: "p", path: "" }).toString()).toBe("pattern=p");
  });
});

describe("findUsagesCodec", () => {
  it("round-trips symbol + path", () => {
    const req = { symbol: "authenticate", path: "/repo" };
    expect(findUsagesCodec.decode(findUsagesCodec.encode(req))).toEqual(req);
  });

  it("returns null without a symbol — an empty submit clears instead of firing", () => {
    expect(
      findUsagesCodec.decode(findUsagesCodec.encode({ symbol: "", path: "/repo" })),
    ).toBeNull();
  });
});
