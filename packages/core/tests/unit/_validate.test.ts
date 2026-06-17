import { describe, expect, it } from "vitest";
import {
  BOOL,
  INT,
  INT_NON_NEG,
  type Spec,
  STR,
  STR_ARRAY,
  Validator,
} from "../../src/_validate.js";

class DemoError extends Error {}

const v = (source = "demo.yaml") => new Validator(DemoError, source);

describe("Validator.get (generic)", () => {
  it("returns undefined when key is absent", () => {
    expect(v().get({}, "k", STR)).toBeUndefined();
  });

  it("returns the supplied default when key is absent", () => {
    expect(v().get({}, "k", STR, "fallback")).toBe("fallback");
  });

  it("does not apply the default for explicit false / 0", () => {
    expect(v().get({ k: false }, "k", BOOL, true)).toBe(false);
    expect(v().get({ k: 0 }, "k", INT, 42)).toBe(0);
  });

  it("validates present values", () => {
    expect(v().get({ k: "hello" }, "k", STR)).toBe("hello");
  });

  it("throws on type mismatch", () => {
    expect(() => v().get({ k: 1 }, "k", STR)).toThrow(/k must be a string/);
  });
});

describe("typed shortcuts", () => {
  it("getInt accepts ints, rejects bool", () => {
    expect(v().getInt({ n: 42 }, "n")).toBe(42);
    expect(() => v().getInt({ n: true }, "n")).toThrow(/must be an integer/);
  });

  it("getInt enforces non-negative", () => {
    expect(v().getInt({ n: 0 }, "n", { nonNegative: true })).toBe(0);
    expect(() => v().getInt({ n: -1 }, "n", { nonNegative: true })).toThrow(/non-negative/);
  });

  it("getBool", () => {
    expect(v().getBool({ flag: false }, "flag")).toBe(false);
    expect(() => v().getBool({ flag: 1 }, "flag")).toThrow(/must be a boolean/);
  });

  it("getStr", () => {
    expect(v().getStr({ name: "alex" }, "name")).toBe("alex");
    expect(() => v().getStr({ name: 1 }, "name")).toThrow(/must be a string/);
  });

  it("getStrArray returns a defensively frozen copy", () => {
    const src = { items: ["a", "b"] };
    const out = v().getStrArray(src, "items");
    expect(out).toEqual(["a", "b"]);
    expect(out).not.toBe(src.items);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("getStrArray rejects non-string items", () => {
    expect(() => v().getStrArray({ items: [1, 2] }, "items")).toThrow(/array of strings/i);
  });
});

describe("custom Spec", () => {
  it("user-defined Spec works without modifying Validator", () => {
    const EVEN: Spec<number> = {
      typeCheck: (x) => typeof x === "number" && Number.isInteger(x) && x % 2 === 0,
      expected: "an even integer",
    };
    expect(v().get({ n: 4 }, "n", EVEN)).toBe(4);
    expect(() => v().get({ n: 3 }, "n", EVEN)).toThrow(/must be an even integer/);
  });

  it("converter runs after validation", () => {
    const UPPER: Spec<string> = {
      typeCheck: (x) => typeof x === "string",
      expected: "a string",
      convert: (x) => (x as string).toUpperCase(),
    };
    expect(v().get({ k: "hello" }, "k", UPPER)).toBe("HELLO");
  });

  it("INT_NON_NEG constant is strict", () => {
    expect(() => v().get({ n: -1 }, "n", INT_NON_NEG)).toThrow(/non-negative/);
  });

  it("STR_ARRAY round-trips", () => {
    expect(v().get({ items: ["a"] }, "items", STR_ARRAY)).toEqual(["a"]);
  });
});

describe("requireRecord", () => {
  it("returns the object", () => {
    expect(v().requireRecord({ a: 1 }, "[section]")).toEqual({ a: 1 });
  });

  it("rejects arrays", () => {
    expect(() => v().requireRecord([1, 2], "[section]")).toThrow(/\[section\] must be an object/);
  });

  it("rejects null", () => {
    expect(() => v().requireRecord(null, "[section]")).toThrow(/must be an object/);
  });
});

describe("error message format", () => {
  it("prefixes source when set", () => {
    expect(() => new Validator(DemoError, "myfile.yaml").getStr({ k: 1 }, "k")).toThrow(
      /^myfile\.yaml: .* must be a string$/,
    );
  });

  it("omits prefix when source is blank", () => {
    expect(() => new Validator(DemoError).getStr({ k: 1 }, "k")).toThrow(/^k must be a string$/);
  });
});
