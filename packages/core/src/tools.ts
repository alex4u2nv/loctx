/**
 * Proactive install of optional analyzer tools into loctx-managed
 * locations, so users don't hand-install system packages.
 *
 *   - lizard, semgrep  → a venv loctx owns (`<dataDir>/tools/venv`), via
 *     `python3 -m venv` + pip. A venv isn't an "externally-managed
 *     environment", so PEP 668 doesn't apply — no `--break-system-packages`,
 *     no sudo, no touching the user's Python.
 *   - ast-grep  → a prebuilt binary fetched from GitHub Releases into
 *     `<dataDir>/tools/bin` (it's a Rust binary, not a Python package).
 *
 * The caller points `analyzers.<tool>.command` at the result (config write →
 * hot-reload → backfill), so enabling a tool becomes one action. Async
 * (execFile / fetch, never spawnSync) so the daemon's HTTP handler doesn't
 * block. Shared by the CLI (`loctx install-tools`) and `/api/tools/install`.
 *
 * Note: semgrep and ast-grep only *run* once `analyzers.<tool>.rule_dirs`
 * point at rules (configured on the admin Config page); installing them just
 * provisions the binary. lizard runs with no extra config.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { execFileAsync as exec } from "./proc.js";

const isWin = process.platform === "win32";

export type ToolName = "lizard" | "semgrep" | "ast-grep";
export const TOOL_NAMES: ReadonlyArray<ToolName> = ["lizard", "semgrep", "ast-grep"];

export interface ToolInstallResult {
  readonly ok: boolean;
  /** Absolute path to the installed binary, when ok. */
  readonly command?: string;
  /** Failure detail, when not ok. */
  readonly error?: string;
  /** Combined stdout+stderr of the install steps, for display in logs/UI. */
  readonly log?: string;
}

const combine = (...parts: Array<string | undefined>): string =>
  parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

const errLog = (err: unknown): string => {
  const e = err as { stdout?: string; stderr?: string };
  return combine(e.stdout, e.stderr) || (err as Error).message;
};

function venvPaths(config: Config): { readonly venv: string; readonly bin: string } {
  const venv = resolve(config.paths.dataDir, "tools", "venv");
  return { venv, bin: resolve(venv, isWin ? "Scripts" : "bin") };
}

function venvBin(config: Config, name: string): string {
  return resolve(venvPaths(config).bin, isWin ? `${name}.exe` : name);
}

function astGrepPath(config: Config): string {
  return resolve(config.paths.dataDir, "tools", "bin", isWin ? "ast-grep.exe" : "ast-grep");
}

/** Where a tool would live once installed by loctx, whether or not present. */
export function managedToolCommand(config: Config, name: ToolName): string {
  return name === "ast-grep" ? astGrepPath(config) : venvBin(config, name);
}

async function findPython(): Promise<string | null> {
  for (const candidate of ["python3", "python"]) {
    try {
      await exec(candidate, ["--version"]);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const tail = (err: unknown): string => {
  const stderr = (err as { stderr?: string }).stderr ?? "";
  const msg = stderr.trim() || (err as Error).message;
  return msg.split("\n").slice(-3).join(" ").trim();
};

function proxyEnv(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.network.proxy !== null) {
    env["HTTPS_PROXY"] = config.network.proxy;
    env["HTTP_PROXY"] = config.network.proxy;
  }
  if (config.network.caCert !== null) env["PIP_CERT"] = config.network.caCert;
  return env;
}

/** Install (or upgrade) a Python tool (lizard, semgrep) into the managed venv. */
async function installPipTool(
  config: Config,
  pkg: string,
  binName: string,
): Promise<ToolInstallResult> {
  const python = await findPython();
  if (python === null) {
    return {
      ok: false,
      error: `python3 not found on PATH — ${pkg} is a Python tool; install Python 3`,
    };
  }
  const { venv, bin } = venvPaths(config);
  const steps: string[] = [];
  if (!existsSync(bin)) {
    try {
      steps.push(`$ ${python} -m venv ${venv}`);
      const r = await exec(python, ["-m", "venv", venv]);
      steps.push(combine(r.stdout, r.stderr));
    } catch (err) {
      return {
        ok: false,
        error: `could not create venv at ${venv}: ${tail(err)}`,
        log: combine(...steps, errLog(err)),
      };
    }
  }
  const pip = resolve(bin, isWin ? "pip.exe" : "pip");
  try {
    steps.push(`$ pip install --upgrade ${pkg}`);
    const r = await exec(pip, ["install", "--upgrade", pkg], {
      env: proxyEnv(config),
      maxBuffer: 64 * 1024 * 1024,
    });
    steps.push(combine(r.stdout, r.stderr));
  } catch (err) {
    return {
      ok: false,
      error: `pip install ${pkg} failed: ${tail(err)}`,
      log: combine(...steps, errLog(err)),
    };
  }
  return { ok: true, command: venvBin(config, binName), log: combine(...steps) };
}

// platform-arch → ast-grep release asset (the zip bundles `ast-grep` + `sg`).
const AST_GREP_ASSETS: Readonly<Record<string, string>> = {
  "darwin-arm64": "app-aarch64-apple-darwin.zip",
  "darwin-x64": "app-x86_64-apple-darwin.zip",
  "linux-x64": "app-x86_64-unknown-linux-gnu.zip",
  "linux-arm64": "app-aarch64-unknown-linux-gnu.zip",
  "win32-x64": "app-x86_64-pc-windows-msvc.zip",
};

interface GhRelease {
  readonly assets?: ReadonlyArray<{ readonly name: string; readonly browser_download_url: string }>;
}

/** Fetch the prebuilt ast-grep binary into the managed tools/bin directory. */
async function installAstGrep(config: Config): Promise<ToolInstallResult> {
  const asset = AST_GREP_ASSETS[`${process.platform}-${process.arch}`];
  if (asset === undefined) {
    return { ok: false, error: `no ast-grep prebuilt for ${process.platform}-${process.arch}` };
  }
  const binDir = resolve(config.paths.dataDir, "tools", "bin");
  mkdirSync(binDir, { recursive: true });
  const dest = astGrepPath(config);
  const headers = { "user-agent": "loctx" }; // GitHub API requires a UA.
  let release: GhRelease;
  try {
    const r = await fetch("https://api.github.com/repos/ast-grep/ast-grep/releases/latest", {
      headers,
    });
    if (!r.ok) return { ok: false, error: `ast-grep release lookup: GitHub returned ${r.status}` };
    release = (await r.json()) as GhRelease;
  } catch (err) {
    return { ok: false, error: `ast-grep release lookup failed: ${(err as Error).message}` };
  }
  const found = release.assets?.find((a) => a.name === asset);
  if (found === undefined) {
    return { ok: false, error: `ast-grep asset ${asset} not in the latest release` };
  }
  const zip = resolve(binDir, asset);
  const steps: string[] = [`fetching ${found.browser_download_url}`];
  try {
    const dl = await fetch(found.browser_download_url, { headers });
    if (!dl.ok)
      return { ok: false, error: `ast-grep download: ${dl.status}`, log: combine(...steps) };
    const bytes = Buffer.from(await dl.arrayBuffer());
    writeFileSync(zip, bytes);
    steps.push(`downloaded ${bytes.length} bytes → ${zip}`);
    const r = await exec("unzip", ["-o", zip, "-d", binDir]);
    steps.push(combine(r.stdout, r.stderr));
    rmSync(zip, { force: true });
  } catch (err) {
    return {
      ok: false,
      error: `ast-grep download/extract failed: ${tail(err)}`,
      log: combine(...steps, errLog(err)),
    };
  }
  if (!existsSync(dest))
    return { ok: false, error: "ast-grep binary missing after extract", log: combine(...steps) };
  chmodSync(dest, 0o755);
  steps.push(`installed ast-grep → ${dest}`);
  return { ok: true, command: dest, log: combine(...steps) };
}

/** Provision one optional analyzer tool; returns its installed binary path. */
export async function installTool(config: Config, name: ToolName): Promise<ToolInstallResult> {
  switch (name) {
    case "lizard":
      return installPipTool(config, "lizard", "lizard");
    case "semgrep":
      return installPipTool(config, "semgrep", "semgrep");
    case "ast-grep":
      return installAstGrep(config);
  }
}

// Back-compat shims (the CLI's no-daemon fallback imports these by name).
export const installLizard = (config: Config): Promise<ToolInstallResult> =>
  installTool(config, "lizard");
export const managedLizardCommand = (config: Config): string =>
  managedToolCommand(config, "lizard");
