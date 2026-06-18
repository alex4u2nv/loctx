/**
 * Proactive install of optional analyzer tools into a loctx-managed
 * environment, so users don't hand-install system packages.
 *
 * lizard is a Python CLI. Installing it into a venv loctx owns
 * (`<dataDir>/tools/venv`) sidesteps PEP 668 "externally-managed
 * environment" errors entirely — no `--break-system-packages`, no sudo,
 * no touching the user's Python. The caller then points
 * `analyzers.lizard.command` at the venv binary (config write →
 * hot-reload → backfill), so enabling lizard becomes one action.
 *
 * Async (execFile, not spawnSync) so the daemon's HTTP handler can run an
 * install without blocking the event loop. Shared by the CLI
 * (`loctx install-tools`) and the web `/api/tools/install` endpoint.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";

const exec = promisify(execFile);

export interface ToolInstallResult {
  readonly ok: boolean;
  /** Absolute path to the installed binary, when ok. */
  readonly command?: string;
  /** Failure detail, when not ok. */
  readonly error?: string;
}

function venvPaths(config: Config): { readonly venv: string; readonly bin: string } {
  const venv = resolve(config.paths.dataDir, "tools", "venv");
  const bin = resolve(venv, process.platform === "win32" ? "Scripts" : "bin");
  return { venv, bin };
}

/** Path lizard would have inside loctx's managed venv (installed or not). */
export function managedLizardCommand(config: Config): string {
  return resolve(venvPaths(config).bin, process.platform === "win32" ? "lizard.exe" : "lizard");
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

/**
 * Install (or upgrade) lizard into loctx's managed venv. Returns the venv
 * binary path on success. The caller wires it into config; this only
 * provisions the tool.
 */
export async function installLizard(config: Config): Promise<ToolInstallResult> {
  const python = await findPython();
  if (python === null) {
    return {
      ok: false,
      error: "python3 not found on PATH — lizard is a Python tool; install Python 3",
    };
  }
  const { venv, bin } = venvPaths(config);
  if (!existsSync(bin)) {
    try {
      await exec(python, ["-m", "venv", venv]);
    } catch (err) {
      return { ok: false, error: `could not create venv at ${venv}: ${tail(err)}` };
    }
  }
  const pip = resolve(bin, process.platform === "win32" ? "pip.exe" : "pip");
  try {
    await exec(pip, ["install", "--upgrade", "lizard"], {
      env: proxyEnv(config),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, error: `pip install lizard failed: ${tail(err)}` };
  }
  return { ok: true, command: managedLizardCommand(config) };
}
