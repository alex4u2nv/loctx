#!/usr/bin/env node
//
// Cross-platform from-source installer for loctx.
//
// Builds the workspace and exposes the `loctx` and `loctx-mcp` binaries on
// your PATH. On macOS/Linux it symlinks the built entrypoints into a bin
// directory; on Windows it writes `.cmd` + `.ps1` shims (Windows symlinks
// need elevation, so shims are how npm/pnpm do it too). Either way the
// shims invoke the in-place `dist/` build, so a later `pnpm run build` is
// picked up with no re-link.
//
// Why not `pnpm link --global` / `npm i -g`? pnpm refuses to link packages
// from inside a workspace, and the CLI depends on `@loctx/core`/`@loctx/web`
// via the `workspace:` protocol (npm can't resolve it) and on the private
// `@loctx/web` build at runtime. So the tool must run from a clone.
//
// Usage:
//   pnpm run install:local              # pnpm install + build, then link
//   node scripts/install.mjs --no-build # skip install/build, just (re)link
//   node scripts/install.mjs --uninstall
//   LOCTX_BIN_DIR=/somewhere node scripts/install.mjs   # override target dir
//
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const isWin = process.platform === "win32";

const bins = [
  { name: "loctx", src: join(repoRoot, "apps", "cli", "dist", "cli.js") },
  { name: "loctx-mcp", src: join(repoRoot, "apps", "mcp", "dist", "server.js") },
];

const defaultBinDir = isWin
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "loctx", "bin")
  : join(homedir(), ".local", "bin");
const binDir = process.env.LOCTX_BIN_DIR ?? defaultBinDir;

const args = new Set(process.argv.slice(2));
if (args.has("-h") || args.has("--help")) {
  // Print the contiguous banner comment block right after the shebang.
  const banner = [];
  for (const line of readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1)) {
    if (!line.startsWith("//")) break;
    banner.push(line.replace(/^\/\/ ?/, ""));
  }
  console.log(banner.join("\n").trim());
  process.exit(0);
}
const doBuild = !args.has("--no-build");
const doUninstall = args.has("--uninstall");

/** Run a command through the shell so `pnpm`/`pnpm.cmd` resolves on every OS. */
const run = (cmd) => {
  const r = spawnSync(cmd, { cwd: repoRoot, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`loctx install: command failed: ${cmd}`);
    process.exit(r.status ?? 1);
  }
};

/** Shim file paths we manage for a given bin name on the current platform. */
const shimPaths = (name) =>
  isWin ? [join(binDir, `${name}.cmd`), join(binDir, `${name}.ps1`)] : [join(binDir, name)];

/** True if `file` is something we created (points back into this repo). */
const ownedByRepo = (file) => {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return resolve(readlinkSync(file)).startsWith(resolve(repoRoot));
    return readFileSync(file, "utf8").includes(repoRoot);
  } catch {
    return false;
  }
};

const uninstall = () => {
  for (const { name } of bins) {
    for (const file of shimPaths(name)) {
      if (existsSync(file) || lstatSafe(file)) {
        if (ownedByRepo(file)) {
          rmSync(file, { force: true });
          console.log(`removed ${file}`);
        } else {
          console.error(`skipped ${file} (not created by this repo)`);
        }
      }
    }
  }
};

const lstatSafe = (f) => {
  try {
    return lstatSync(f);
  } catch {
    return null;
  }
};

const linkOne = ({ name, src }) => {
  if (isWin) {
    const cmd = join(binDir, `${name}.cmd`);
    const ps1 = join(binDir, `${name}.ps1`);
    writeFileSync(cmd, `@node "${src}" %*\r\n`);
    writeFileSync(ps1, `#!/usr/bin/env pwsh\nnode "${src}" $args\nexit $LASTEXITCODE\n`);
    console.log(`shimmed ${name} -> ${src}`);
  } else {
    const link = join(binDir, name);
    rmSync(link, { force: true });
    symlinkSync(src, link);
    console.log(`linked ${name} -> ${src}`);
  }
};

const onPath = () => {
  const norm = (d) => (isWin ? resolve(d).toLowerCase() : resolve(d));
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((d) => norm(d) === norm(binDir));
};

// --- main ---------------------------------------------------------------

if (doUninstall) {
  uninstall();
  process.exit(0);
}

if (doBuild) {
  console.log("==> pnpm install");
  run("pnpm install");
  console.log("==> pnpm run build");
  run("pnpm run build");
}

for (const { src } of bins) {
  if (!existsSync(src)) {
    console.error(`loctx install: missing build output '${src}'.`);
    console.error("Run without --no-build, or run 'pnpm run build' first.");
    process.exit(1);
  }
}

mkdirSync(binDir, { recursive: true });
for (const bin of bins) linkOne(bin);

if (!onPath()) {
  console.log(`\nNOTE: ${binDir} is not on your PATH. Add it:`);
  if (isWin) {
    console.log(`  PowerShell:  setx PATH "$env:PATH;${binDir}"   (then restart the shell)`);
  } else {
    console.log(`  export PATH="${binDir}:$PATH"   (add to ~/.zshrc or ~/.bashrc)`);
  }
}

console.log("\nDone. Try: loctx --version");
