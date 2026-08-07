/**
 * Shared CLI context + small helpers used by every command module.
 *
 * The `program` singleton is owned here so `getCtx()` can read the
 * global `-c/--config` / `--debug` flags AFTER parse. Command modules
 * register against this same instance (passed in by `cli.ts`), and the
 * action callbacks call `getCtx()` at action-time, never at registration
 * time — that timing is load-bearing.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type Config,
  ConfigError,
  defaultConfigFile,
  findContainingProject,
  loadConfig,
  type Project,
} from "@loctx/core";
import { Command } from "commander";

export interface CliContext {
  readonly configPath: string;
  readonly debug: boolean;
}

/**
 * The CLI's exit-code contract (CLI-7, 2026-08-06 audit). Before this
 * constant, three conventions coexisted (`process.exit(n)`, bare
 * `process.exitCode = n`, plain return) and the "conflict" code 2 was a
 * magic number in two files.
 *
 *   ok       0 — success (including "nothing matched" reads)
 *   error    1 — any failure
 *   conflict 2 — the daemon refused because the work is already in
 *                flight (refresh mid-reconcile, rebuild all-rejected)
 */
export const EXIT = { ok: 0, error: 1, conflict: 2 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Print `message` to stderr and exit. Use only outside try/finally cleanup. */
export function fail(message: string, code: ExitCode = EXIT.error): never {
  console.error(message);
  process.exit(code);
}

/**
 * Message text for an arbitrary thrown value (CLI-10, 2026-08-06
 * audit). Replaces the `(err as Error).message` casts: a non-Error
 * throw (string, plain object) used to print `failed: undefined` in
 * exactly the diagnostic paths where the message mattered.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Module-level singleton: `getCtx()` reads its parsed opts, `cli.ts`
// configures it and calls `parseAsync`, command modules register onto it.
export const program = new Command();

export function getCtx(): CliContext {
  const opts = program.opts<{ config?: string; debug?: boolean }>();
  return Object.freeze({
    configPath: opts.config ?? defaultConfigFile(),
    debug: opts.debug ?? false,
  });
}

export function loadConfigOrFail(ctx: CliContext): Config {
  try {
    return loadConfig(ctx.configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      fail(err.message);
    }
    throw err;
  }
}

/**
 * Resolve the user's PATH argument to a concrete project root. Used by
 * every command that operates on "a project" — `add`, `activate`,
 * `deactivate`, `pause`, `resume`, `rebuild`, `purge`.
 *
 *   - `undefined` (no arg) or `"."` → walk up from `process.cwd()`
 *   - any other value             → walk up from `resolve(value)`
 *
 * Walking up means: if the supplied directory isn't itself a project
 * root, climb parents until a marker (`.git`, `package.json`, …) is
 * found. So `loctx add` works from `proj/src/components/` the same way
 * `loctx add ~/code/proj` does. Returns `null` when no marker exists
 * anywhere on the chain — callers should error with a helpful message.
 */
export function resolveCommandPath(input: string | undefined): Project | null {
  const start = input === undefined || input === "." ? process.cwd() : resolve(input);
  return findContainingProject(start);
}

/**
 * Print the "no project marker found at or above …" error and exit(1).
 * Factored out of the six command sites (add/activate/deactivate/rebuild/
 * purge and the pause/resume scope resolver) that each recomputed the
 * same start path and message. `suffix` carries the per-command tail
 * (e.g. the `add` marker list, or `Pass --all to <verb> every project.`).
 */
export function noProjectMarkerError(verb: string, path: string | undefined, suffix = ""): never {
  const start = path === undefined || path === "." ? process.cwd() : resolve(path);
  fail(`[loctx ${verb}] no project marker found at or above ${start}.${suffix}`);
}

/**
 * Print a y/N confirmation prompt. Enter → "no" (safe default).
 * Reads from /dev/tty when stdin is piped so test-driven invocations
 * with no controlling terminal still error gracefully (caller passes
 * `--yes`). Async because readline-question is callback-based.
 */
export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((res) => {
      rl.question(`${message} [y/N] `, (a) => res(a));
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
