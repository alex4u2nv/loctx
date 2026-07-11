/**
 * Version drift guard (#451). Three hardcoded "0.1.0" constants once
 * drifted two minors behind the real package version. The CLI now reads
 * package.json at runtime; this test fails if the reported version ever
 * disagrees with the manifest again.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliJs = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as { version: string };

describe("loctx --version (#451)", () => {
  it("reports the package.json version", () => {
    const out = execFileSync(process.execPath, [cliJs, "--version"], {
      encoding: "utf-8",
    }).trim();
    expect(out).toBe(manifest.version);
    expect(out).not.toBe("0.1.0");
  });
});
