/**
 * Architecture invariants enforced as tests.
 *
 * These read source files at module-load time and assert structural
 * invariants that pure type-checking can't catch — directional import
 * rules, no-cycle guarantees, etc. They run with the regular test
 * suite so a violation lights up CI and `npm test` locally.
 *
 * Today (#164):
 *   - `analyzers/*` must never import `container.ts`. The container
 *     instantiates the EnrichmentQueue and wires its `onResult` sink
 *     via a closure over `state`. If an analyzer module starts
 *     importing back into the container, the wiring becomes a cycle
 *     that only manifests at runtime (in load order) and is easy to
 *     miss in review.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ANALYZERS_DIR = join(__dirname, "..", "..", "src", "analyzers");

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

describe("module boundaries", () => {
  it("analyzers/* must not import container.ts (#164)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesIn(ANALYZERS_DIR)) {
      const src = readFileSync(file, "utf-8");
      // Match `from "../container"`, `from "../container.js"`,
      // `from "../../container..."`, etc. Tolerant of single and
      // double quotes; ignores import-type-only forms (those don't
      // create a runtime edge).
      if (/from\s+['"]\.\.\/(?:[^'"]*\/)?container(?:\.js)?['"]/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
