#!/usr/bin/env node
/**
 * MCP stdio server skeleton.
 *
 * Exposes three tools for MCP-capable coding agents (Claude Code, Codex, etc.):
 *   - search_workspace   — semantic search over the local index
 *   - workspace_status   — discovered projects + storage paths
 *   - refresh_workspace  — reindex one project (or all)
 *
 * Real @modelcontextprotocol/sdk wiring is the next step. This file lays out
 * the request/response shapes and stubs the server entry point.
 */

import { buildRuntime, loadConfig } from "@loctx/core";

interface SearchToolInput {
  readonly query: string;
  readonly cwd?: string;
  readonly scope?: "auto" | "project" | "subtree" | "all";
  readonly limit?: number;
  readonly language?: string;
}

interface StatusToolInput {
  readonly include_indexed_counts?: boolean;
}

interface RefreshToolInput {
  readonly path?: string;
}

async function handleSearch(input: SearchToolInput) {
  const config = loadConfig();
  const runtime = await buildRuntime(config);
  try {
    return await runtime.searcher.search({
      query: input.query,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      scope: input.scope ?? "auto",
      limit: input.limit ?? 10,
      ...(input.language !== undefined ? { language: input.language } : {}),
    });
  } finally {
    runtime.close();
  }
}

async function handleStatus(input: StatusToolInput) {
  const config = loadConfig();
  const runtime = await buildRuntime(config);
  try {
    const projects = runtime.discovery.discoverProjects();
    const baseline = {
      configPath: config.source ?? null,
      paths: config.paths,
      embedding: config.embedding,
      workspaceRoots: config.workspaceRoots,
      projects: projects.map((p) => ({ id: p.id, name: p.name, root: p.root })),
    };
    if (!input.include_indexed_counts) return baseline;
    return {
      ...baseline,
      indexedFileCounts: Object.fromEntries(
        projects.map((p) => [p.id, runtime.state.listFiles(p.id).length] as const),
      ),
    };
  } finally {
    runtime.close();
  }
}

async function handleRefresh(input: RefreshToolInput) {
  const config = loadConfig();
  const runtime = await buildRuntime(config);
  try {
    const projects = input.path
      ? [runtime.discovery.resolveProject(input.path)].filter((p) => p !== null)
      : runtime.discovery.discoverProjects();
    const summaries = [];
    for (const project of projects) {
      summaries.push(await runtime.indexer.indexProject(project));
    }
    return summaries;
  } finally {
    runtime.close();
  }
}

async function main(): Promise<void> {
  // TODO: wire @modelcontextprotocol/sdk Server over stdio and register the
  // three tools above. Keeping the handlers exported as plain async functions
  // keeps them testable without the MCP transport.
  console.error(
    "[loctx-mcp] stub — real @modelcontextprotocol/sdk wiring pending. " +
      "Tool handlers (handleSearch / handleStatus / handleRefresh) are exported.",
  );
}

export { handleRefresh, handleSearch, handleStatus };
export type { RefreshToolInput, SearchToolInput, StatusToolInput };

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
