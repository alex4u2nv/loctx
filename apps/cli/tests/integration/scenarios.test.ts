/**
 * End-to-end CLI scenarios (#99).
 *
 * Walks user-shaped command sequences and asserts each step's exit code,
 * stdout/stderr, and observable filesystem state. Spawns the compiled
 * `loctx` binary (apps/cli/dist/cli.js) the same way a real install
 * would invoke it.
 *
 * Hermetic by default: every test gets a fresh tmp workspace, isolated
 * data + config dirs, and uses FakeEmbeddingProvider so no network
 * traffic happens. The optional 'real-network smoke' scenario at the
 * bottom downloads a real model and runs `index → search` against it
 * — gated by `LOCTX_E2E_NETWORK=1` so CI doesn't pull ~90 MB on every
 * run.
 *
 * Requires the workspace to have been built first (`npm run build`).
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_PATH = resolve(__dirname, "..", "..", "dist", "cli.js");

interface CtxPaths {
  readonly workspace: string;
  readonly project: string;
  readonly data: string;
  readonly cfg: string;
}

let ctx: CtxPaths;

beforeEach(() => {
  const workspace = mkdtempSync(join(tmpdir(), "loctx-scenario-"));
  const project = join(workspace, "demo");
  const data = join(workspace, "data");
  const cfg = join(workspace, "cfg");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(cfg, { recursive: true });

  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");
  writeFileSync(
    join(project, "src", "auth.ts"),
    [
      "// Authentication helpers. Verify a bearer token and return a session.",
      "",
      "export async function authenticate(token: string) {",
      "  if (!token) throw new Error('missing bearer token for authentication');",
      "  return { userId: token, role: 'user' };",
      "}",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(project, "src", "rate-limit.ts"),
    [
      "// Rate limiter middleware. Throttles requests per source.",
      "",
      "export function rateLimit(opts: { perMinute: number }) {",
      "  const counts = new Map<string, number>();",
      "  return (key: string) => {",
      "    const n = (counts.get(key) ?? 0) + 1;",
      "    counts.set(key, n);",
      "    return n <= opts.perMinute;",
      "  };",
      "}",
    ].join("\n"),
    "utf-8",
  );

  ctx = Object.freeze({ workspace, project, data, cfg });
});

afterEach(() => {
  if (ctx?.workspace !== undefined) rmSync(ctx.workspace, { recursive: true, force: true });
});

/** Run the built CLI with isolated data + fake embeddings. Captures everything. */
function runCli(
  args: ReadonlyArray<string>,
  extraEnv: Record<string, string> = {},
  cwd?: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf-8",
    ...(cwd !== undefined ? { cwd } : {}),
    env: {
      ...process.env,
      LOCTX_DATA_DIR: ctx.data,
      LOCTX_CONFIG_DIR: ctx.cfg,
      LOCTX_EMBEDDING_PROVIDER: "fake",
      ...extraEnv,
    },
  });
}

describe("loctx CLI: hermetic full-flow scenario", () => {
  it("index → search → doctor: indexes a project, finds a chunk, reports healthy", () => {
    // 1. Index the demo project.
    const indexed = runCli(["index", ctx.project]);
    expect(indexed.status).toBe(0);
    expect(indexed.stdout).toContain("Indexing demo");
    expect(indexed.stdout).toMatch(/indexed=2/);

    // 2. Search for content present in the fixture. Lexical branch matches
    //    the standalone token "authentication" in the docstring + throw.
    const searched = runCli(["search", "authentication", "--path", ctx.project]);
    expect(searched.status).toBe(0);
    expect(searched.stdout).toContain("scope: project(demo)");
    expect(searched.stdout).toContain("src/auth.ts");

    // 3. Doctor reports no errors. Exits 0 even with warnings.
    const doc = runCli(["doctor"]);
    expect(doc.status).toBe(0);
    // At least the embedding + config + paths checks should be healthy.
    expect(doc.stdout).toMatch(/\[ ok \]\s+config/);
    expect(doc.stdout).toMatch(/\[ ok \]\s+embedding/);
    expect(doc.stdout).toMatch(/\[ ok \]\s+retrieval/);
    // FTS5 probe surfaces with a non-zero row count after the index above.
    expect(doc.stdout).toMatch(/\[ ok \]\s+fts5\s+chunks_fts queryable, \d+ rows indexed/);
  });

  it("find-usages locates the definition site of an exported symbol", () => {
    // index produces the symbol_refs table the find-usages reader consumes.
    expect(runCli(["index", ctx.project]).status).toBe(0);

    // No daemon in the test harness → falls back to a local one-shot
    // runtime (no embedding model needed; symbol_refs is a pure SQLite
    // read). The fixture's auth.ts defines `authenticate`.
    const r = runCli(["find-usages", "authenticate", "--path", ctx.project]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("project: demo");
    expect(r.stdout).toContain("def");
    expect(r.stdout).toContain("src/auth.ts");
  });

  it("find-usages --path and --all are mutually exclusive", () => {
    const r = runCli(["find-usages", "authenticate", "--path", ctx.project, "--all"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("mutually exclusive");
  });

  it("model use writes config; doctor reflects the new model", () => {
    // --yes skips the interactive confirm (#315 / cli sibling). Without
    // a TTY in the test harness, the confirm would refuse and exit 1.
    const used = runCli(["model", "use", "Xenova/bge-small-en-v1.5", "--yes"]);
    expect(used.status).toBe(0);
    expect(used.stderr).toContain("switched embedding.model to Xenova/bge-small-en-v1.5");

    const cur = runCli(["model", "current"]);
    expect(cur.status).toBe(0);
    expect(cur.stdout.trim()).toBe("Xenova/bge-small-en-v1.5");

    const doc = runCli(["doctor"]);
    expect(doc.stdout).toContain("Xenova/bge-small-en-v1.5");
  });

  it("purge --force clears the index after a re-index", () => {
    expect(runCli(["index", ctx.project]).status).toBe(0);

    const purged = runCli(["purge", ctx.project, "--force"]);
    expect(purged.status).toBe(0);
    expect(purged.stderr).toContain("cleared");

    // Search now returns nothing for that project.
    const searched = runCli(["search", "authentication", "--path", ctx.project]);
    expect(searched.stdout).toContain("results: 0");
  });

  it("reset index --force without --force is rejected", () => {
    const noForce = runCli(["reset", "index"]);
    expect(noForce.status).not.toBe(0);
    expect(noForce.stderr).toContain("refusing without --force");
  });

  it("first-run: config init writes template, config show reads it back", () => {
    const init = runCli(["config", "init"]);
    expect(init.status).toBe(0);
    expect(init.stderr).toContain("wrote");

    const show = runCli(["config", "show"]);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("loctx config (effective)");
    // The template sets workspace_roots to ~/Workspaces; the env-isolated
    // cfg dir resolves the leaf source as 'global', not 'default'.
    expect(show.stdout).toMatch(/workspace_roots:/);
  });

  it("add -y from inside a project walks up to the root and activates", () => {
    // Run from a nested directory; the walk-up logic must find the
    // .git marker at ctx.project and activate that project.
    const nested = join(ctx.project, "src");
    const added = runCli(["add", "-y"], {}, nested);
    expect(added.status).toBe(0);
    expect(added.stderr).toContain("resolved project: demo");
    expect(added.stderr).toContain("[loctx activate] demo");
    expect(added.stderr).toMatch(/indexed=\d+/);
  });

  it("add fails clearly when no project marker is anywhere on the chain", () => {
    // Run from a directory outside any project (the workspace tmp root
    // has no marker — only its `demo/` child does).
    const orphan = runCli(["add", "-y"], {}, ctx.workspace);
    expect(orphan.status).not.toBe(0);
    expect(orphan.stderr).toContain("no project marker found");
  });

  it("purge . resolves cwd's project (no path required)", () => {
    expect(runCli(["index", ctx.project]).status).toBe(0);

    const nested = join(ctx.project, "src");
    const purged = runCli(["purge", ".", "--force"], {}, nested);
    expect(purged.status).toBe(0);
    expect(purged.stderr).toContain("cleared demo");
  });

  it("model-swap warns about reindex requirement (#99)", () => {
    // The 'model use' command writes the new model to config and emits
    // a warning telling the user the next start will trip
    // CollectionIdentityMismatch unless they reset + reindex. The
    // warning copy is the contract this regression test pins.
    const swap = runCli(["model", "use", "Xenova/bge-small-en-v1.5", "--yes"]);
    expect(swap.status).toBe(0);
    const all = `${swap.stderr}${swap.stdout}`;
    expect(all).toMatch(/reset.*index|CollectionIdentityMismatch|reindex/i);
  });
});

describe.skipIf(process.env["LOCTX_E2E_NETWORK"] !== "1")(
  "loctx CLI: real-network smoke (LOCTX_E2E_NETWORK=1)",
  () => {
    it("model download → index → search returns a real result", () => {
      // No fake-provider override here; the network gate must let
      // model-download through and the real ONNX pipeline must produce
      // embeddings.
      const dl = runCli(["model", "download", "Xenova/all-MiniLM-L6-v2"], {
        LOCTX_EMBEDDING_PROVIDER: "",
      });
      expect(dl.status).toBe(0);
      expect(dl.stderr).toContain("done");

      const indexed = runCli(["index", ctx.project], { LOCTX_EMBEDDING_PROVIDER: "" });
      expect(indexed.status).toBe(0);
      expect(indexed.stdout).toMatch(/indexed=2/);

      const searched = runCli(
        ["search", "rate limit middleware", "--path", ctx.project],
        { LOCTX_EMBEDDING_PROVIDER: "" },
      );
      expect(searched.status).toBe(0);
      expect(searched.stdout).toContain("src/rate-limit.ts");
    }, 120_000);
  },
);

