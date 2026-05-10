#!/usr/bin/env node
/**
 * Bump core, cli, mcp to the same version. Rewrites the cross-dep range.
 * Usage: node scripts/release-bump.mjs <patch|minor|major|X.Y.Z>
 * Prints next git steps. See CONTRIBUTING.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PACKAGES = ["packages/core", "apps/cli", "apps/mcp"];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`release-bump: ${msg}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, obj) {
  // Match npm's formatting: two-space indent, trailing newline.
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(v);
  if (!m) fail(`unparseable version: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function bump(current, kind) {
  const { major, minor, patch } = parseSemver(current);
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "major") return `${major + 1}.0.0`;
  return null;
}

function resolveTarget(arg, currentCore) {
  if (!arg) fail("missing version arg (e.g. 0.2.0, patch, minor, major)");
  const bumped = bump(currentCore, arg);
  if (bumped !== null) return bumped;
  // Treat as explicit version.
  parseSemver(arg);
  return arg;
}

const arg = process.argv[2];
const corePkgPath = resolve(ROOT, "packages/core/package.json");
const corePkg = readJson(corePkgPath);
const target = resolveTarget(arg, corePkg.version);

console.error(`release-bump: ${corePkg.version} → ${target}`);

for (const pkgDir of PACKAGES) {
  const path = resolve(ROOT, pkgDir, "package.json");
  const pkg = readJson(path);
  pkg.version = target;
  if (pkg.dependencies && pkg.dependencies["@loctx/core"]) {
    pkg.dependencies["@loctx/core"] = `^${target}`;
  }
  writeJson(path, pkg);
  console.error(`  bumped ${pkg.name} → ${target}`);
}

console.error("");
console.error("Next steps:");
console.error("  1. Update CHANGELOG.md: move [Unreleased] under [" + target + "] - " +
  new Date().toISOString().slice(0, 10));
console.error('  2. git commit -am "release: v' + target + '"');
console.error("  3. git tag v" + target + " && git push origin main v" + target);
