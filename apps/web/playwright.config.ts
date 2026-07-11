/**
 * Playwright config for the loctx admin UI E2E tests.
 *
 * Setup happens at config-load time (synchronously) because Playwright
 * spawns the `webServer` BEFORE running globalSetup, so any state the
 * daemon needs to read at boot must already exist.
 *
 * What this file does, in order:
 *   1. Wipes any prior PW_DATA / PW_CONFIG / PW_FIXTURE dirs.
 *   2. Materialises a fixture project on disk (.git + source files).
 *   3. Writes a config.yaml under PW_CONFIG with the fixture path as
 *      workspace_roots and the test port as daemon.port.
 *   4. Spawns `loctx index` against the fixture so the chunks are in
 *      SQLite + LanceDB before the daemon comes up.
 *   5. Configures the webServer to spawn `loctx start` with isolated
 *      env + cwd that doesn't trip walk-up project-config discovery.
 *
 * Hermetic: uses FakeEmbeddingProvider so no network or model
 * download happens.
 *
 * Pre-requisite: `npm run build` has produced apps/cli/dist/cli.js,
 * apps/web/dist/client (Vite SPA), and apps/web/dist/server (Hono).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_PATH = resolve(REPO_ROOT, "apps", "cli", "dist", "cli.js");

const PORT = process.env["LOCTX_PW_PORT"] ?? "33121";
const DATA_DIR = process.env["LOCTX_PW_DATA"] ?? "/tmp/loctx-pw-data";
const CONFIG_DIR = process.env["LOCTX_PW_CONFIG"] ?? "/tmp/loctx-pw-cfg";
const FIXTURE_ROOT = process.env["LOCTX_PW_FIXTURE"] ?? "/tmp/loctx-pw-fixture";

prepareFixture();

function prepareFixture(): void {
  for (const dir of [DATA_DIR, CONFIG_DIR, FIXTURE_ROOT]) {
    rmSync(dir, { recursive: true, force: true });
  }

  // Fixture project: minimal git-marked repo with searchable content.
  const project = join(FIXTURE_ROOT, "demo");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
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
      "  return (key: string) => true;",
      "}",
    ].join("\n"),
    "utf-8",
  );

  // Nested inner package (#276/#449): carries its own package.json
  // marker but is NOT separately indexed — its files belong to the
  // parent demo project's index (absorbed marker, #286). find-usages
  // scoped to a path inside it must widen to the indexed parent.
  const innerPkg = join(project, "packages", "inner");
  mkdirSync(join(innerPkg, "src"), { recursive: true });
  writeFileSync(join(innerPkg, "package.json"), '{ "name": "inner" }\n', "utf-8");
  writeFileSync(
    join(innerPkg, "src", "use-auth.ts"),
    [
      "// Consumes the parent project's authenticate helper.",
      "",
      "export async function login(token: string) {",
      "  const session = { token };",
      "  return session;",
      "}",
    ].join("\n"),
    "utf-8",
  );

  // Config: point loctx at the fixture, set the test port.
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(CONFIG_DIR, "config.yaml"),
    [
      "workspace_roots:",
      `  - ${FIXTURE_ROOT}`,
      "",
      "daemon:",
      `  port: ${PORT}`,
      "  hostname: localhost",
      "",
      "watcher:",
      "  debounce_ms: 100",
    ].join("\n"),
    "utf-8",
  );

  // Index the fixture before the daemon boots so the search page has data.
  const result = spawnSync(process.execPath, [CLI_PATH, "index", project], {
    env: {
      ...process.env,
      LOCTX_DATA_DIR: DATA_DIR,
      LOCTX_CONFIG_DIR: CONFIG_DIR,
      LOCTX_EMBEDDING_PROVIDER: "fake",
    },
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `[playwright config] loctx index failed (exit ${result.status})\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false, // single daemon shared across tests
  workers: 1,
  reporter: process.env["CI"] ? [["list"], ["github"]] : "list",

  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium" }],

  webServer: {
    command: `node ${CLI_PATH} start --no-watch`,
    url: `http://localhost:${PORT}/`,
    timeout: 60_000,
    reuseExistingServer: false,
    cwd: FIXTURE_ROOT,
    env: Object.fromEntries(
      Object.entries({
        ...process.env,
        LOCTX_DATA_DIR: DATA_DIR,
        LOCTX_CONFIG_DIR: CONFIG_DIR,
        LOCTX_EMBEDDING_PROVIDER: "fake",
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  },
});
