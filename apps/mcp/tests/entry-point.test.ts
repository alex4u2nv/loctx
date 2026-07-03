/**
 * Regression: the stdio binary must start `main()` when launched through a
 * symlink, not only through its realpath.
 *
 * Package managers install `loctx-mcp` as a symlink (Homebrew:
 * /opt/homebrew/bin/loctx-mcp -> …/@loctx/mcp/dist/server.js). The old
 * entry-point guard compared `import.meta.url` (a realpath) against a raw
 * `file://${process.argv[1]}` (the symlink path); they never matched, so
 * `main()` silently never ran and the MCP client reported the server as
 * "failed" with no output. `isProcessEntry` realpaths argv[1] so the two
 * agree regardless of symlinks.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessEntry } from "../src/server.js";

let dir: string;
let real: string;
let link: string;
// import.meta.url is always the module's *realpath* — mirror that. (macOS
// tmpdir lives under /var, itself a symlink to /private/var, so the raw temp
// path is not its own realpath.)
let metaUrl: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loctx-entry-"));
  real = join(dir, "server.js");
  link = join(dir, "loctx-mcp"); // stands in for the bin symlink
  writeFileSync(real, "// entry\n");
  symlinkSync(real, link);
  metaUrl = pathToFileURL(realpathSync(real)).href;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isProcessEntry", () => {
  it("matches when launched via the realpath", () => {
    expect(isProcessEntry(metaUrl, real)).toBe(true);
  });

  it("matches when launched via a symlink (the Homebrew install path)", () => {
    expect(isProcessEntry(metaUrl, link)).toBe(true);
  });

  it("does not match an unrelated entry (imported, not the entry point)", () => {
    const other = join(dir, "other.js");
    writeFileSync(other, "// other\n");
    expect(isProcessEntry(metaUrl, other)).toBe(false);
  });

  it("returns false when there is no argv[1]", () => {
    expect(isProcessEntry(metaUrl, undefined)).toBe(false);
  });
});
