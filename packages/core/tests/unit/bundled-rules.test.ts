import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bundledAstGrepRulesDir } from "../../src/analyzers/index.js";

describe("bundled ast-grep starter rules", () => {
  it("resolves to a directory shipped with the package", () => {
    const dir = bundledAstGrepRulesDir();
    expect(existsSync(dir)).toBe(true);
  });

  it("contains valid ast-grep rule files (id + language + rule)", () => {
    const dir = bundledAstGrepRulesDir();
    const yml = readdirSync(dir).filter((f) => f.endsWith(".yml"));
    expect(yml.length).toBeGreaterThan(0);
    for (const f of yml) {
      const body = readFileSync(`${dir}/${f}`, "utf8");
      expect(body).toMatch(/^id:\s*\S+/m);
      expect(body).toMatch(/^language:\s*\S+/m);
      expect(body).toMatch(/^rule:/m);
    }
  });
});
