#!/usr/bin/env node
/**
 * Build a self-contained loctx release tarball for distribution via GitHub
 * Releases. The tarball is the `pnpm deploy` output — cli + bundled
 * @loctx/{core,web,mcp} + the full runtime node_modules INCLUDING the
 * already-built native binaries (better-sqlite3, tree-sitter, lancedb,
 * onnxruntime). Recipients extract and run: no `npm install`, no compile,
 * no prebuild download, no TLS at install time.
 *
 * Trade-off: the bundled natives are platform + Node-ABI specific, so the
 * tarball name encodes platform-arch-nodeMAJOR. Build one per target (a CI
 * matrix when opening up); for a same-platform small team, one build.
 *
 * Usage: node scripts/build-release.mjs   (run `pnpm run build` first)
 * Output: release/loctx-<version>-<platform>-<arch>-node<major>.tgz
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPkg = JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8"));
const version = cliPkg.version;

const releaseDir = join(repoRoot, "release");
const stage = join(releaseDir, "loctx"); // extracted dir name recipients get
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// Self-contained deploy: real node_modules (incl. native .node), @loctx/*
// inlined. pnpm uses relative symlinks into .pnpm, so the dir is portable.
console.log("==> pnpm deploy (self-contained runtime)");
execFileSync("pnpm", ["--filter", "@loctx/cli", "deploy", "--prod", stage], {
  cwd: repoRoot,
  stdio: "inherit",
});

// loctx-mcp (stdio) rides along when @loctx/mcp landed in the closure (via
// @loctx/web). Record which bins the tarball provides for the installer.
const bins = { loctx: "dist/cli.js" };
if (existsSync(join(stage, "node_modules/@loctx/mcp/dist/server.js"))) {
  bins["loctx-mcp"] = "node_modules/@loctx/mcp/dist/server.js";
}

// Bundle the installer so a tarball can self-update (`loctx update` re-runs
// it; recipients can also re-run it directly to pull the latest release).
cpSync(join(repoRoot, "scripts/install-release.sh"), join(stage, "install-release.sh"));
// Apache-2.0 §4(a): every recipient of the artifact gets the License.
// NOTICE carries the third-party attributions (Font Awesome CC BY 4.0,
// bundled libvips LGPL) that live nowhere else in the tarball.
cpSync(join(repoRoot, "LICENSE"), join(stage, "LICENSE"));
cpSync(join(repoRoot, "NOTICE"), join(stage, "NOTICE"));
writeFileSync(
  join(stage, "loctx-release.json"),
  JSON.stringify({ version, bins, builtFor: platformTag(), builtAt: null }, null, 2),
);

const out = join(releaseDir, `loctx-${version}-${platformTag()}.tgz`);
console.log("==> tar");
execFileSync("tar", ["-czf", out, "-C", releaseDir, "loctx"], { cwd: repoRoot, stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });

console.log(`\nbuilt ${out}`);
console.log(`bins: ${Object.keys(bins).join(", ")}`);
console.log("install: extract, then run scripts/install-release.sh (or symlink loctx -> dist/cli.js)");

function platformTag() {
  return `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`;
}
