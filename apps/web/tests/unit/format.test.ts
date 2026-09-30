import { describe, expect, it } from "vitest";
import { formatBytes, formatCompact, formatPercent } from "../../client/lib/format.js";

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

describe("formatPercent", () => {
  it("rounds a fraction to a whole percentage", () => {
    expect(formatPercent(0.337)).toBe("34%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("never prints 0% for a non-zero share", () => {
    expect(formatPercent(0.004)).toBe("<1%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(Number.NaN)).toBe("0%");
  });
});

describe("formatBytes", () => {
  it("picks the unit and decimals the /projects size cell relies on", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3 GB");
  });
});
