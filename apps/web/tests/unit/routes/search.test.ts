/**
 * POST /api/search — input validation, workspace-root path confinement,
 * response shaping, and error sanitization. Drives the real handler with
 * a faked searcher/runtime.
 */

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSearch } from "../../../server/api/search.js";
import { appWith, fakeConfig, fakeRuntime, postJson } from "../helpers/harness.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loctx-search-"));
  mkdirSync(join(root, "demo"), { recursive: true });
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/search — validation", () => {
  const app = () => appWith(mountSearch, fakeConfig(), fakeRuntime());

  it("400s on a non-JSON body", async () => {
    const res = await app().request("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("400s when query is missing or empty", async () => {
    expect((await postJson(app(), "/api/search", {})).status).toBe(400);
    expect((await postJson(app(), "/api/search", { query: "   " })).status).toBe(400);
  });

  it("400s on an out-of-range limit", async () => {
    expect((await postJson(app(), "/api/search", { query: "x", limit: 0 })).status).toBe(400);
    expect((await postJson(app(), "/api/search", { query: "x", limit: 5000 })).status).toBe(400);
    expect((await postJson(app(), "/api/search", { query: "x", limit: "10" })).status).toBe(400);
  });

  it("400s on a non-string language and a non-boolean coverage", async () => {
    expect((await postJson(app(), "/api/search", { query: "x", language: 7 })).status).toBe(400);
    expect((await postJson(app(), "/api/search", { query: "x", coverage: "yes" })).status).toBe(400);
  });
});

describe("POST /api/search — path confinement", () => {
  it("403s when the path escapes every workspace_root", async () => {
    const app = appWith(mountSearch, fakeConfig({ workspaceRoots: [root] }), fakeRuntime());
    const { status, body } = await postJson(app, "/api/search", {
      query: "x",
      path: "/etc",
    });
    expect(status).toBe(403);
    expect((body as { error: string }).error).toContain("workspace_root");
  });

  it("passes the confined path through to the searcher", async () => {
    const search = vi.fn(async () => ({
      resolvedScope: { mode: "subtree", project: { id: "p1", name: "demo" }, relPrefix: "" },
      results: [],
      warnings: [],
    }));
    const app = appWith(
      mountSearch,
      fakeConfig({ workspaceRoots: [root] }),
      fakeRuntime({ searcher: { search: search as never } }),
    );
    const { status } = await postJson(app, "/api/search", {
      query: "auth",
      path: join(root, "demo"),
    });
    expect(status).toBe(200);
    expect(search).toHaveBeenCalledTimes(1);
    expect((search.mock.calls[0]?.[0] as { path?: string }).path).toContain("demo");
  });
});

describe("POST /api/search — happy path + errors", () => {
  it("returns the shaped payload and prepends reconcile warnings", async () => {
    const app = appWith(
      mountSearch,
      fakeConfig(),
      fakeRuntime({
        searcher: {
          search: (async () => ({
            resolvedScope: { mode: "all", project: null, relPrefix: null },
            results: [],
            warnings: ["searcher note"],
          })) as never,
        },
        reconcile: {
          running: true,
          total: 3,
          completed: 1,
          currentProjectName: "demo",
          currentProjectIndexed: 2,
          currentProjectTotal: 10,
        },
      }),
    );
    const { status, body } = await postJson(app, "/api/search", { query: "auth" });
    expect(status).toBe(200);
    const payload = body as { warnings: string[]; resolvedScope: { mode: string } };
    expect(payload.resolvedScope.mode).toBe("all");
    expect(payload.warnings[0]).toContain("reconciling");
    expect(payload.warnings).toContain("searcher note");
  });

  it("500s with a sanitized error when the searcher throws (no internals leaked)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = appWith(
      mountSearch,
      fakeConfig(),
      fakeRuntime({
        searcher: {
          search: (async () => {
            throw new Error("/Users/alex/secret ONNX blew up");
          }) as never,
        },
      }),
    );
    const { status, body } = await postJson(app, "/api/search", { query: "auth" });
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: "internal_error", code: "search" });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(spy).toHaveBeenCalled();
  });
});
