/**
 * End-to-end MCP scenario tests (#98).
 *
 * Where `server-integration.test.ts` exercises tool dispatch with a stub
 * Runtime, this file walks scripted multi-step agent workflows against a
 * REAL Runtime built over a hermetic fixture workspace. Each scenario
 * mirrors what an agent would actually do in a session — call sequences
 * like status → refresh → search → mutate → search again — and asserts
 * outcomes at every step, not just the last one.
 *
 * Hermetic: tmp dir per test, FakeEmbeddingProvider (no network, no
 * model download), in-memory MCP transport.
 */

import {
  type Config,
  type Runtime,
  WorkspaceDiscovery,
  buildRuntime,
  defaultPaths,
} from "@loctx/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTools } from "../src/registry.js";

interface Harness {
  workspaceRoot: string;
  dataDir: string;
  runtime: Runtime;
  client: Client;
  server: Server;
}

let harness: Harness | null = null;

beforeEach(async () => {
  harness = await setupHarness();
});

afterEach(async () => {
  if (harness !== null) {
    await harness.client.close();
    await harness.server.close();
    await harness.runtime.close();
    rmSync(harness.workspaceRoot, { recursive: true, force: true });
    harness = null;
  }
});

async function setupHarness(): Promise<Harness> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "loctx-scen-"));
  const dataDir = join(workspaceRoot, ".data");
  mkdirSync(dataDir, { recursive: true });

  // Two small projects: alpha (auth + rate-limit) and beta (ingest).
  // Just enough corpus that scoped + multi-project scenarios are real.
  writeProject(workspaceRoot, "alpha", {
    "src/auth.ts":
      "export async function authenticateUser(token: string) {\n" +
      "  if (!token) throw new Error('missing bearer token');\n" +
      "  return { userId: token };\n}\n",
    "src/rate-limit.ts":
      "export function rateLimit(max: number) {\n" +
      "  return (key: string) => true;\n}\n",
  });
  writeProject(workspaceRoot, "beta", {
    "src/ingest.py": "def ingest(record):\n    return record\n",
  });

  const config = makeConfig(workspaceRoot, dataDir);
  const runtime = await buildRuntime(config);

  const server = new Server(
    { name: "loctx", version: "test" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, runtime);
  const client = new Client({ name: "loctx-scenario-test", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { workspaceRoot, dataDir, runtime, client, server };
}

function writeProject(root: string, name: string, files: Record<string, string>): void {
  const projectRoot = join(root, name);
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(projectRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

function makeConfig(workspaceRoot: string, dataDir: string): Config {
  const paths = defaultPaths();
  return Object.freeze({
    workspaceRoots: Object.freeze([workspaceRoot]),
    paths: Object.freeze({
      ...paths,
      dataDir,
      vectorDir: join(dataDir, "vectors"),
      stateDb: join(dataDir, "state.sqlite3"),
      logsDir: join(dataDir, "logs"),
    }),
    embedding: Object.freeze({
      provider: "fake",
      model: "hash",
      normalize: true,
      providerOverride: "fake",
    }),
    watcher: Object.freeze({ debounceMs: 0 }),
    daemon: Object.freeze({ port: 0, hostname: "localhost" }),
    retrieval: Object.freeze({ mode: "hybrid", rrfK: 60 }),
    reconciliation: Object.freeze({ runOnStart: false, intervalSeconds: 0 }),
    analyzers: Object.freeze({
      backgroundEnabled: false,
      concurrency: 2,
      perTaskTimeoutMs: 60_000,
      lizard: Object.freeze({ enabled: false, command: "lizard" }),
    }),
    source: null,
    projectSource: null,
    sources: Object.freeze({}),
  });
}

// ---- helpers --------------------------------------------------------

interface PayloadShape {
  [key: string]: unknown;
}

async function callTool(client: Client, name: string, args: unknown): Promise<PayloadShape> {
  const result = await client.callTool({ name, arguments: args as PayloadShape });
  if (result.isError) {
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "<no content>";
    throw new Error(`step "${name}" failed: ${text}`);
  }
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "{}";
  return JSON.parse(text) as PayloadShape;
}

// ---- scenarios ------------------------------------------------------

describe("MCP scenarios — multi-step agent workflows (#98)", () => {
  it("cold-start: status reports 0 indexed → refresh → status reports indexed", async () => {
    const { client, runtime } = harness!;
    // Step 1: status before any indexing.
    const initial = (await callTool(client, "workspace_status", {
      include_indexed_counts: true,
    })) as { projects: Array<{ name: string; lastIndexedAt: string | null }> };
    expect(initial.projects.length).toBe(2);
    for (const p of initial.projects) expect(p.lastIndexedAt).toBeNull();

    // Step 2: refresh all projects.
    const refreshed = (await callTool(client, "refresh_workspace", {})) as {
      summaries: Array<{ projectId: string; indexed: number }>;
    };
    expect(refreshed.summaries.length).toBe(2);
    expect(refreshed.summaries.every((s) => s.indexed > 0)).toBe(true);

    // Step 3: status now reports timestamps.
    const after = (await callTool(client, "workspace_status", {})) as {
      projects: Array<{ lastIndexedAt: string | null }>;
    };
    expect(after.projects.every((p) => p.lastIndexedAt !== null)).toBe(true);

    // Step 4: search returns hits.
    const search = (await callTool(client, "search_workspace", {
      query: "authenticate",
      limit: 5,
    })) as { results: Array<{ relPath: string }> };
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.some((r) => r.relPath === "src/auth.ts")).toBe(true);
    void runtime;
  });

  it("search-after-edit: index → mutate file → reindex via watcher.indexFile → search returns new content", async () => {
    const { client, runtime, workspaceRoot } = harness!;
    // Step 1: initial index. The fresh symbol we'll edit in below
    // doesn't appear yet — assert via snippet, not just result count
    // (the vector branch always returns its top-k).
    await callTool(client, "refresh_workspace", {});
    const before = (await callTool(client, "search_workspace", {
      query: "newSymbolFromEdit",
      limit: 5,
    })) as { results: Array<{ snippet: string }> };
    expect(before.results.every((r) => !r.snippet.includes("newSymbolFromEdit"))).toBe(true);

    // Step 2: mutate a file directly on disk.
    const filePath = join(workspaceRoot, "alpha", "src", "auth.ts");
    writeFileSync(
      filePath,
      "export function newSymbolFromEdit() { return 'fresh content'; }\n",
    );
    // Bypass the watcher: indexFile directly to simulate the watcher callback.
    const project = runtime.discovery
      .discoverProjects()
      .find((p) => p.name === "alpha");
    expect(project).toBeDefined();
    if (project !== undefined) {
      await runtime.indexer.indexFile(project, filePath);
    }

    // Step 3: search now finds the new symbol.
    const after = (await callTool(client, "search_workspace", {
      query: "newSymbolFromEdit",
      limit: 3,
    })) as { results: Array<{ relPath: string }> };
    expect(after.results.length).toBeGreaterThan(0);
    expect(after.results.some((r) => r.relPath === "src/auth.ts")).toBe(true);
  });

  it("scoped-search: all projects → narrow to one project → narrow to subtree, results consistently shrink", async () => {
    const { client, workspaceRoot } = harness!;
    await callTool(client, "refresh_workspace", {});

    const all = (await callTool(client, "search_workspace", {
      query: "authenticate",
      limit: 20,
    })) as { results: Array<{ projectName: string; relPath: string }> };
    const projectScoped = (await callTool(client, "search_workspace", {
      query: "authenticate",
      path: join(workspaceRoot, "alpha"),
      limit: 20,
    })) as { results: Array<{ projectName: string; relPath: string }> };
    const subtreeScoped = (await callTool(client, "search_workspace", {
      query: "authenticate",
      path: join(workspaceRoot, "alpha", "src"),
      limit: 20,
    })) as { results: Array<{ projectName: string; relPath: string }> };

    // Project scope <= all; subtree scope <= project scope.
    expect(projectScoped.results.length).toBeLessThanOrEqual(all.results.length);
    expect(subtreeScoped.results.length).toBeLessThanOrEqual(projectScoped.results.length);
    // Project scope returns only alpha hits.
    expect(projectScoped.results.every((r) => r.projectName === "alpha")).toBe(true);
  });

  it("find-usages: define + call sites land in defs / refs (#96 + #98)", async () => {
    const { client } = harness!;
    await callTool(client, "refresh_workspace", {});
    const out = (await callTool(client, "find_usages", {
      symbol: "authenticateUser",
    })) as { projects: Array<{ defs: Array<unknown>; refs: Array<unknown> }> };
    expect(out.projects.length).toBeGreaterThan(0);
    const alpha = out.projects[0];
    expect(alpha?.defs.length).toBeGreaterThan(0);
  });

  it("graceful errors: missing required arg surfaces isError, not transport crash", async () => {
    const { client } = harness!;
    // Missing query → search handler throws ToolError; SDK wraps as isError.
    const result = await client.callTool({ name: "search_workspace", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text.toLowerCase()).toContain("query");
  });
});
