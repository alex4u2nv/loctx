/**
 * End-to-end smoke for `loctx start`.
 *
 * Spawns the compiled CLI as a child process against an isolated tmp
 * workspace + storage, polls every route, exercises each MCP method, then
 * sends SIGTERM and asserts a clean exit. Uses `LOCTX_EMBEDDING_PROVIDER=fake`
 * so the test doesn't download the HF model.
 *
 * Requires the workspace to have been built first (`npm run build`).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_PATH = resolve(__dirname, "..", "..", "dist", "cli.js");

let workspace: string;
let port: number;
let child: ChildProcess;
let stdoutBuffer = "";
let stderrBuffer = "";

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "loctx-e2e-"));
  port = 33000 + Math.floor(Math.random() * 1000);

  // Fake project under the workspace root so cwd-default discovery picks it up.
  const project = join(workspace, "demo");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(
    join(project, "main.py"),
    "def hello():\n    return 'hi'\n\n\nclass Greeter:\n    def greet(self):\n        return hello()\n",
    "utf-8",
  );
  writeFileSync(join(project, "README.md"), "# Demo project\n", "utf-8");

  // Port comes from the global config since CLI flags no longer override
  // it and the project-level `.loctx.yaml` layer was removed. `LOCTX_CONFIG_DIR`
  // below points the loader at this directory.
  mkdirSync(join(workspace, "config"), { recursive: true });
  writeFileSync(
    join(workspace, "config", "config.yaml"),
    `daemon:\n  port: ${port}\n  hostname: localhost\n`,
    "utf-8",
  );

  child = spawn(process.execPath, [CLI_PATH, "start", "--no-watch"], {
    cwd: workspace,
    env: {
      ...process.env,
      LOCTX_EMBEDDING_PROVIDER: "fake",
      LOCTX_DATA_DIR: join(workspace, "data"),
      LOCTX_CONFIG_DIR: join(workspace, "config"),
      // Suppress the chatty HF dtype line in case it slips through.
      TRANSFORMERS_VERBOSITY: "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Capture so we can dump on failure. Drained either way to avoid back-
  // pressure stalling the child process.
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
  });

  try {
    await waitForReady(port, 30_000);
  } catch (err) {
    // Surface diagnostic info so CI failures aren't a black hole.
    const exit = child.exitCode === null ? "still running" : `exit=${child.exitCode}`;
    console.error(
      `\n[loctx-e2e] daemon failed to come up (${exit}). Dumping captured output:\n` +
        `--- stdout ---\n${stdoutBuffer.slice(-4000) || "(empty)"}\n` +
        `--- stderr ---\n${stderrBuffer.slice(-4000) || "(empty)"}\n--- end ---\n`,
    );
    throw err;
  }
}, 60_000);

afterAll(async () => {
  if (child !== undefined && child.exitCode === null) {
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      // Last-resort SIGKILL after 8s.
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 8_000);
    });
  }
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
}, 30_000);

describe("loctx start", () => {
  it("serves the admin UI at /", async () => {
    const response = await fetch(`http://localhost:${port}/`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("loctx");
  });

  it("serves /projects", async () => {
    const response = await fetch(`http://localhost:${port}/projects`);
    expect(response.status).toBe(200);
  });

  it("serves /search", async () => {
    const response = await fetch(`http://localhost:${port}/search`);
    expect(response.status).toBe(200);
  });

  it("MCP initialize returns serverInfo", async () => {
    const result = await mcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "loctx-e2e", version: "1" },
    });
    expect(result.serverInfo?.name).toBe("loctx");
    expect(result.protocolVersion).toBe("2024-11-05");
  });

  it("MCP tools/list returns the seven loctx tools", async () => {
    const result = await mcpCall("tools/list");
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
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

  it("MCP tools/call workspace_status discovers the fake project", async () => {
    const result = await mcpCall("tools/call", {
      name: "workspace_status",
      arguments: {},
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "{}";
    const payload = JSON.parse(text) as { projects: Array<{ name: string }> };
    expect(payload.projects.some((p) => p.name === "demo")).toBe(true);
  });
});

// ---- helpers ------------------------------------------------------------

async function waitForReady(p: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${p}/`);
      if (r.ok || r.status < 500) return;
    } catch {
      // not ready yet
    }
    await sleep(250);
  }
  throw new Error(`server did not come up on port ${p} in ${timeoutMs}ms`);
}

async function mcpCall(
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1_000_000),
    method,
    ...(params !== undefined ? { params } : {}),
  });
  const response = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body,
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (dataLine === undefined) {
    throw new Error(`no SSE data line in /mcp response: ${text.slice(0, 200)}`);
  }
  const payload = JSON.parse(dataLine.slice("data: ".length)) as
    | { result: Record<string, unknown> }
    | { error: { message: string } };
  if ("error" in payload) {
    throw new Error(`MCP error from ${method}: ${payload.error.message}`);
  }
  return payload.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
