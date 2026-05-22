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
import { afterEach, describe, expect, it } from "vitest";
import { registerTools } from "../src/registry.js";

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

function stubRuntime(overrides: Partial<Runtime> = {}): Runtime {
  const projects = [{ id: "proj-a", name: "alpha", root: "/ws/alpha" }];
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
    indexer: { indexProject: async () => ({ project: projects[0]!, indexed: 0, skipped: 0, failed: 0, elapsedSeconds: 0, failures: [], total: 0 }) },
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

async function connectedPair(runtime: Runtime): Promise<{ client: Client; server: Server }> {
  const server = new Server({ name: "loctx", version: "test" }, { capabilities: { tools: {} } });
  registerTools(server, runtime);
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
  it("tools/list returns the six loctx tools", async () => {
    const { client } = await connectedPair(stubRuntime());
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([
      "search_workspace",
      "workspace_status",
      "find_usages",
      "find_duplicates",
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
});
