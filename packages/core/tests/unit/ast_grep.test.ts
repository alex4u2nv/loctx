/**
 * ast-grep adapter invocation (#ast-grep-rules). The bug: `runAstGrep`
 * passed the rule *directory* to `--rule`, which only accepts a single
 * rule file, so every scan failed with "Is a directory" — ~10k failed
 * enrichments. Rules now go through a generated `sgconfig.yml` +
 * `--config`. These lock in the config generation and (when the binary
 * is present) the end-to-end scan.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AST_GREP_VERSION,
  bundledAstGrepRulesDir,
  detectAstGrep,
  runAstGrep,
  sgConfigForRuleDirs,
} from "../../src/analyzers/index.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sgConfigForRuleDirs (#ast-grep-rules)", () => {
  it("writes a valid sgconfig.yml with the rule dirs under ruleDirs", () => {
    const path = sgConfigForRuleDirs(["/rules/a", "/rules/b"]);
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/^ruleDirs:/m);
    expect(body).toContain('"/rules/a"');
    expect(body).toContain('"/rules/b"');
  });

  it("double-quotes paths so a dir with spaces stays valid YAML", () => {
    const spaced = "/Users/x/Application Support/loctx/rules";
    const body = readFileSync(sgConfigForRuleDirs([spaced]), "utf8");
    expect(body).toContain(`"${spaced}"`);
  });

  it("caches by rule-dir set (same input → same path, order-independent)", () => {
    const a = sgConfigForRuleDirs(["/r/1", "/r/2"]);
    const b = sgConfigForRuleDirs(["/r/2", "/r/1"]);
    expect(a).toBe(b);
    expect(sgConfigForRuleDirs(["/r/3"])).not.toBe(a);
  });
});

describe("AST_GREP_VERSION", () => {
  it("is bumped past 1 so the old failed enrichments re-run on backfill", () => {
    expect(AST_GREP_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe("runAstGrep end-to-end (skipped when ast-grep isn't installed)", () => {
  it("scans a file against the bundled rules via --config and returns findings", async () => {
    const command = await detectAstGrep();
    if (command === null) return; // ast-grep not on PATH — CI-safe skip
    const dir = mkdtempSync(join(tmpdir(), "loctx-ag-e2e-"));
    tmps.push(dir);
    const file = join(dir, "leftover.ts");
    writeFileSync(file, "export function f() {\n  debugger;\n  return 1;\n}\n");
    const result = await runAstGrep(file, {
      command,
      ruleDirs: [bundledAstGrepRulesDir()],
      maxFindingsPerFile: 50,
    });
    // The bundled set flags leftover `debugger` — proving the invocation
    // works (the old `--rule <dir>` form errored before any match).
    expect(result.findings.some((f) => f.ruleId.includes("debugger"))).toBe(true);
  });
});
