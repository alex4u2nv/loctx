/**
 * End-to-end test for the MCP Server + registry adapter.
 *
 * Uses the SDK's InMemoryTransport to spin up a real Server + Client pair in
 * one process. Verifies tools/list and tools/call dispatch through to the
 * registry handlers without needing a real Runtime — a stub stands in.
 */

import type { Runtime, SearchResponse } from "@loctx/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../src/registry.js";

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

function stubRuntime(overrides: Partial<Runtime> = {}): Runtime {
  const projectA = { id: "proj-a", name: "alpha", root: "/ws/alpha" };
  const projects = [projectA];
  return {
    config: {
      source: null,
      sources: {},
      workspaceRoots: ["/ws"],
      paths: {
        dataDir: "/data",
        configDir: "/cfg",
        vectorDir: "/data/vectors",
        stateDb: "/data/state.sqlite3",
        logsDir: "/data/logs",
      },
      embedding: { provider: "fake", model: "hash", normalize: true },
      watcher: { debounceMs: 300 },
      daemon: { port: 3000, hostname: "localhost" },
    },
    discovery: {
      discoverProjects: () => projects,
      discoverWithMarkers: () =>
        projects.map((p) => ({ project: p, marker: ".git", markerKind: "git" })),
      resolveProject: () => null,
      configuredRoots: ["/ws"],
    },
    state: {
      listFiles: () => [],
      listProjects: () => [],
      findDuplicateGroups: () => [],
      findLiteralMatches: () => [],
      readUsageStats: () => [],
      getFile: () => null,
      applyUsageDeltas: () => {},
    },
    searcher: {
      search: async () =>
        ({
          resolvedScope: { mode: "all", project: null, relPrefix: null, inputPath: null },
          results: [
            {
              projectId: "proj-a",
              relPath: "src/x.ts",
              startLine: 1,
              endLine: 3,
              score: 0.9,
              snippet: "x",
              language: "typescript",
              kind: "function",
              symbols: [],
            },
          ],
          warnings: [],
        }) satisfies SearchResponse,
    },
    indexer: {
      indexProject: async () => ({
        project: projectA,
        indexed: 0,
        skipped: 0,
        failed: 0,
        elapsedSeconds: 0,
        failures: [],
        total: 0,
      }),
    },
    reconciler: {
      status: () => ({
        running: false,
        startedAt: null,
        currentProjectName: null,
        completed: 0,
        total: 0,
      }),
    },
    rules: {
      ignoredDirs: new Set([".git", "node_modules"]),
      noiseGlobs: ["package-lock.json"],
      secretGlobs: [".env"],
      allowedNamedFiles: new Set(),
    },
    embeddings: {},
    vectors: {},
    close: () => undefined,
    ...overrides,
  } as unknown as Runtime;
}

async function connectedPair(
  runtime: Runtime,
  options?: Parameters<typeof registerTools>[2],
): Promise<{ client: Client; server: Server }> {
  const server = new Server({ name: "loctx", version: "test" }, { capabilities: { tools: {} } });
  registerTools(server, runtime, options ?? {});
  const client = new Client({ name: "loctx-test", version: "test" }, { capabilities: {} });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, server };
}

describe("MCP Server + registry over in-memory transport", () => {
  it("tools/list returns the seven loctx tools", async () => {
    const { client } = await connectedPair(stubRuntime());
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([
      "search_workspace",
      "workspace_status",
      "find_usages",
      "find_duplicates",
      "quality_report",
      "find_literal",
      "refresh_workspace",
    ]);
  });

  it("tools/call workspace_status returns project metadata", async () => {
    const { client } = await connectedPair(stubRuntime());
    const result = await client.callTool({ name: "workspace_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    expect(content?.type).toBe("text");
    const payload = JSON.parse(content?.text ?? "{}");
    expect(payload.projects[0].id).toBe("proj-a");
  });

  it("tools/call search_workspace forwards to the runtime searcher", async () => {
    const { client } = await connectedPair(stubRuntime());
    const result = await client.callTool({
      name: "search_workspace",
      arguments: { query: "hello", limit: 5 },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    );
    expect(payload.results[0].relPath).toBe("src/x.ts");
  });

  it("tools/call returns isError when the handler throws", async () => {
    const { client } = await connectedPair(stubRuntime());
    // Missing required `query` argument.
    const result = await client.callTool({ name: "search_workspace", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("tools/call returns isError for an unknown tool", async () => {
    const { client } = await connectedPair(stubRuntime());
    const result = await client.callTool({ name: "totally_made_up", arguments: {} });
    expect(result.isError).toBe(true);
  });

  // ---- admin_workspace gating (mcp.admin_enabled) ------------------

  function adminRuntime(adminEnabled: boolean): Runtime {
    const base = stubRuntime();
    return stubRuntime({
      config: {
        ...(base.config as Runtime["config"]),
        mcp: { logMaxRows: 200, adminEnabled },
      } as unknown as Runtime["config"],
      compactVectors: async () => ({ beforeBytes: 100, afterBytes: 40 }),
      backfillAnalyzers: async () => ({ enqueued: 0 }),
    } as Partial<Runtime>);
  }

  it("hides admin_workspace from tools/list when admin is disabled", async () => {
    const { client } = await connectedPair(adminRuntime(false));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("admin_workspace");
  });

  it("lists + dispatches admin_workspace when admin is enabled", async () => {
    const { client } = await connectedPair(adminRuntime(true));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("admin_workspace");

    const result = await client.callTool({
      name: "admin_workspace",
      arguments: { action: "compact" },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    );
    expect(payload.action).toBe("compact");
    expect(payload.freedBytes).toBe(60);
  });

  it("refuses an admin_workspace call when admin is disabled even if the name is guessed", async () => {
    const { client } = await connectedPair(adminRuntime(false));
    const result = await client.callTool({
      name: "admin_workspace",
      arguments: { action: "compact" },
    });
    expect(result.isError).toBe(true);
  });

  // ---- observability (#452) ----------------------------------------

  it("surfaces injected process faults on workspace_status", async () => {
    const snapshot = {
      total: 3,
      unique: 1,
      lastAt: "2026-07-16T00:00:00.000Z",
      recent: [
        {
          signature: "unhandledRejection:boom",
          kind: "unhandledRejection" as const,
          count: 3,
          lastDetail: "boom",
          lastAt: "2026-07-16T00:00:00.000Z",
        },
      ],
    };
    const { client } = await connectedPair(stubRuntime(), { processFaults: () => snapshot });
    const result = await client.callTool({ name: "workspace_status", arguments: {} });
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    );
    expect(payload.processFaults).toEqual(snapshot);
  });

  it("omits processFaults when no tracker is injected (web transport)", async () => {
    const { client } = await connectedPair(stubRuntime());
    const result = await client.callTool({ name: "workspace_status", arguments: {} });
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}",
    );
    expect(payload.processFaults).toBeUndefined();
  });

  it("defers request logging off the response critical path (setImmediate)", async () => {
    const runtime = stubRuntime();
    (runtime.config as { mcp?: unknown }).mcp = { logMaxRows: 100 };
    const logMcpRequest = vi.fn();
    (runtime.state as { logMcpRequest?: unknown }).logMcpRequest = logMcpRequest;

    const { client } = await connectedPair(runtime);
    await client.callTool({ name: "workspace_status", arguments: {} });
    // The response resolved via promise microtasks; the deferred
    // setImmediate write is a macrotask that hasn't run yet.
    expect(logMcpRequest).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(logMcpRequest).toHaveBeenCalledTimes(1);
  });
});
