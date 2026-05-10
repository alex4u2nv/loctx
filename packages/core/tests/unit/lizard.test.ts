/**
 * Tests for the Lizard adapter (#62). Pure parser / detector — does
 * not require the lizard binary. Indexer integration is exercised by
 * scenarios elsewhere; here we pin the CSV-shape contract.
 */

import { describe, expect, it } from "vitest";
import { detectLizard, parseLizardCsv } from "../../src/analyzers/lizard.js";

describe("parseLizardCsv", () => {
  it("parses lizard's CSV emit into per-function metrics", () => {
    // Synthetic but matches the shape lizard 1.17 emits.
    const csv = [
      "12,5,80,2,18,src/auth.ts:10-27,src/auth.ts,authenticate",
      "5,2,30,1,8,src/auth.ts:30-37,src/auth.ts,verify",
    ].join("\n");
    const result = parseLizardCsv("src/auth.ts", csv);
    expect(result.file).toBe("src/auth.ts");
    expect(result.functions).toHaveLength(2);
    expect(result.functions[0]).toMatchObject({
      name: "authenticate",
      nloc: 12,
      ccn: 5,
      tokens: 80,
      parameters: 2,
      lineFrom: 10,
      lineTo: 27,
    });
  });

  it("ignores blank lines and comment lines", () => {
    const csv = ["", "# stats summary", "8,3,50,2,12,src/x.ts:1-12,src/x.ts,foo", ""].join("\n");
    expect(parseLizardCsv("src/x.ts", csv).functions).toHaveLength(1);
  });

  it("tolerates short rows (older lizard versions) by skipping them", () => {
    const csv = ["1,2,3"].join("\n");
    expect(parseLizardCsv("src/x.ts", csv).functions).toEqual([]);
  });

  it("skips rows with non-numeric metrics", () => {
    const csv = ["NLOC,CCN,token,PARAM,length,location,filename,name"].join("\n");
    expect(parseLizardCsv("src/x.ts", csv).functions).toEqual([]);
  });

  it("handles location strings without a file prefix", () => {
    const csv = ["6,1,20,0,7,1-7,bare.py,bare"].join("\n");
    const fns = parseLizardCsv("bare.py", csv).functions;
    expect(fns[0]?.lineFrom).toBe(1);
    expect(fns[0]?.lineTo).toBe(7);
  });
});

describe("detectLizard", () => {
  it("returns null when the configured command is not on PATH", async () => {
    // Made-up binary name; the test is hermetic.
    const found = await detectLizard("definitely-not-installed-loctx-lizard-9b7d2");
    expect(found).toBeNull();
  });
});
