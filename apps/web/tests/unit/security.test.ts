/**
 * localDaemonGuard — the Host + Origin gate that keeps a localhost-bound,
 * no-auth daemon safe from DNS-rebinding and cross-origin CSRF. Mounted
 * on a throwaway Hono app and driven with app.request() so the real
 * middleware logic (header parsing, path matching, preflight, CORS echo)
 * runs end to end. No server, no ports.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { localDaemonGuard } from "../../server/security.js";

const PORT = 3022;

function makeApp() {
  const app = new Hono();
  app.use("*", localDaemonGuard({ hostname: "127.0.0.1", port: PORT }));
  app.get("/", (c) => c.text("index"));
  app.get("/assets/app.js", (c) => c.text("bundle"));
  app.post("/api/search", (c) => c.json({ ok: true }));
  app.get("/api/status", (c) => c.json({ ok: true }));
  app.post("/mcp", (c) => c.json({ ok: true }));
  return app;
}

const goodHost = { host: `127.0.0.1:${PORT}` };
const goodOrigin = `http://127.0.0.1:${PORT}`;

describe("localDaemonGuard — unprotected paths", () => {
  it("lets static assets and the SPA index through without any header checks", async () => {
    const app = makeApp();
    expect((await app.request("/", { headers: { host: "evil.example" } })).status).toBe(200);
    expect(
      (await app.request("/assets/app.js", { headers: { host: "evil.example" } })).status,
    ).toBe(200);
  });
});

describe("localDaemonGuard — Host check", () => {
  it("rejects a /api request with an unexpected Host (DNS-rebinding)", async () => {
    const res = await makeApp().request("/api/status", {
      headers: { host: "attacker.test" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("unexpected Host");
  });

  it("rejects a missing Host header", async () => {
    // Hono's test client omits Host unless set; the guard treats "" as invalid.
    const app = makeApp();
    const req = new Request("http://x/api/status");
    req.headers.delete("host");
    expect((await app.fetch(req)).status).toBe(403);
  });

  it("accepts every loopback alias on the bound port", async () => {
    const app = makeApp();
    for (const host of [
      `127.0.0.1:${PORT}`,
      `localhost:${PORT}`,
      `[::1]:${PORT}`,
    ]) {
      const res = await app.request("/api/status", { headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });

  it("is case-insensitive on the Host value", async () => {
    const res = await makeApp().request("/api/status", {
      headers: { host: `LOCALHOST:${PORT}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("localDaemonGuard — Origin check", () => {
  it("allows an absent Origin (curl / same-origin fetch)", async () => {
    const res = await makeApp().request("/api/status", { headers: goodHost });
    expect(res.status).toBe(200);
  });

  it("treats 'null' and empty Origin as absent", async () => {
    const app = makeApp();
    for (const origin of ["null", ""]) {
      const res = await app.request("/api/status", {
        headers: { ...goodHost, origin },
      });
      expect(res.status, origin).toBe(200);
    }
  });

  it("allows a matching Origin and echoes it back (not '*')", async () => {
    const res = await makeApp().request("/api/status", {
      headers: { ...goodHost, origin: goodOrigin },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(goodOrigin);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("rejects a cross-origin browser fetch on /api", async () => {
    const res = await makeApp().request("/api/search", {
      method: "POST",
      headers: { ...goodHost, origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("unexpected Origin");
  });
});

describe("localDaemonGuard — /mcp Origin relaxation", () => {
  it("allows a non-browser MCP client identifier as Origin on /mcp", async () => {
    const res = await makeApp().request("/mcp", {
      method: "POST",
      headers: { ...goodHost, origin: "claude-code" },
    });
    expect(res.status).toBe(200);
  });

  it("still rejects a browser-shaped cross-origin on /mcp", async () => {
    const res = await makeApp().request("/mcp", {
      method: "POST",
      headers: { ...goodHost, origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("does NOT relax the same non-browser Origin on /api", async () => {
    const res = await makeApp().request("/api/search", {
      method: "POST",
      headers: { ...goodHost, origin: "claude-code" },
    });
    expect(res.status).toBe(403);
  });
});

describe("localDaemonGuard — CORS preflight", () => {
  it("answers a valid OPTIONS preflight with 204 + allow headers", async () => {
    const res = await makeApp().request("/api/search", {
      method: "OPTIONS",
      headers: { ...goodHost, origin: goodOrigin },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(goodOrigin);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("rejects an OPTIONS preflight from a bad Origin before emitting CORS headers", async () => {
    const res = await makeApp().request("/api/search", {
      method: "OPTIONS",
      headers: { ...goodHost, origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
