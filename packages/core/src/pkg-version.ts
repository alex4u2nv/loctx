/**
 * Read a package's `version` from its package.json at runtime.
 *
 * Exists because three hardcoded version constants (CLI, daemon, MCP
 * serverInfo) drifted two minors behind the real package version and
 * `loctx --version` reported 0.1.0 on a 0.4.x install (#451). Callers
 * pass a URL relative to their own module so the same helper works from
 * `src/` under tsx and from the compiled `dist/` layout:
 *
 *   readPackageVersion(new URL("../package.json", import.meta.url))
 */

import { readFileSync } from "node:fs";

export function readPackageVersion(packageJsonUrl: URL): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonUrl, "utf-8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    // A missing/unreadable package.json should never take the binary
    // down over a version string.
    return "0.0.0";
  }
}
