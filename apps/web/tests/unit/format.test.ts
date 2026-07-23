import { describe, expect, it } from "vitest";
import { formatCompact } from "../../client/lib/format.js";

describe("formatCompact", () => {
  it("prints small counts verbatim", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(7)).toBe("7");
    expect(formatCompact(812)).toBe("812");
    expect(formatCompact(999)).toBe("999");
  });

  it("uses k for thousands, one decimal only under 10k", () => {
    expect(formatCompact(1_000)).toBe("1.0k");
    expect(formatCompact(5_400)).toBe("5.4k");
    expect(formatCompact(42_000)).toBe("42k");
    expect(formatCompact(541_517)).toBe("542k");
  });

  it("uses M for millions", () => {
    expect(formatCompact(1_240_000)).toBe("1.2M");
    expect(formatCompact(9_900_000)).toBe("9.9M");
  });

  it("clamps non-finite and negative input to 0", () => {
    expect(formatCompact(Number.NaN)).toBe("0");
    expect(formatCompact(-5)).toBe("0");
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe("0");
  });
});
