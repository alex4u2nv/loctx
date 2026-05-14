/**
 * Admin UI end-to-end tests.
 *
 * Drives the live Vite-built SPA + Hono daemon through Chromium. The
 * fixture project (set up in playwright.config.ts) is already indexed
 * before the daemon comes up, so /search returns deterministic results.
 */

import { expect, test } from "@playwright/test";

test.describe("loctx admin UI", () => {
  test("dashboard renders the hero, embedding identity, and the demo project", async ({
    page,
  }) => {
    await page.goto("/");
    // Hero card title (Phoenix-style "INDEX FLOW" headline, rendered
    // across two lines).
    await expect(page.getByRole("heading", { name: /Index\s+Flow/ })).toBeVisible();
    // Embedding model surfaces somewhere — in the daemon card and in
    // the details tile. Either render satisfies the contract.
    await expect(page.getByText(/Xenova\/all-MiniLM/).first()).toBeVisible();
    // Project from the fixture appears in the flow's output column.
    await expect(page.getByText("demo").first()).toBeVisible();
  });

  test("projects page lists the fixture project as active with compact stats", async ({
    page,
  }) => {
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    const activeRow = page.getByRole("row").filter({ hasText: "demo" });
    await expect(activeRow.first()).toBeVisible();
    // The combined-stats column says "N files".
    await expect(activeRow.first().getByText(/\d+ files/)).toBeVisible();
    // Activity column renders relative time.
    await expect(activeRow.first().getByText(/indexed/)).toBeVisible();
  });

  test("search returns the indexed auth chunk", async ({ page }) => {
    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();

    await page.getByLabel("query").fill("authentication");
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page.getByText(/result/i).first()).toBeVisible();
    await expect(page.getByText("src/auth.ts").first()).toBeVisible();
  });

  test("scope label reflects project when search is scoped to a path", async ({ page }) => {
    await page.goto(`/search?q=rate+limit&path=${encodeURIComponent("/tmp/loctx-pw-fixture/demo")}`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText(/scope:/i).first()).toBeVisible();
    await expect(page.getByText("demo").first()).toBeVisible();
  });

  test("doctor page lists health checks", async ({ page }) => {
    await page.goto("/doctor");
    await expect(page.getByRole("heading", { name: "Doctor" })).toBeVisible();
    await expect(page.getByText(/summary:/)).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "embedding" }).first()).toBeVisible();
  });

  test("config page renders effective config JSON", async ({ page }) => {
    await page.goto("/config");
    await expect(page.getByRole("heading", { name: "Effective config" })).toBeVisible();
    await expect(page.getByText(/embedding/).first()).toBeVisible();
  });

  test("models page lists at least one model and shows the active marker", async ({ page }) => {
    await page.goto("/models");
    await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
    // Table renders with rows; the seeded model should appear with "active".
    await expect(page.getByRole("row").filter({ hasText: "active" }).first()).toBeVisible();
  });

  test("find-usages returns the seeded authenticate symbol", async ({ page }) => {
    await page.goto("/find-usages");
    await expect(page.getByRole("heading", { name: "Find usages" })).toBeVisible();
    await page.getByLabel("symbol").fill("authenticate");
    await page.getByRole("button", { name: "Find" }).click();
    // The fixture's auth.ts exports `authenticate` so we expect a definition row.
    await expect(page.getByText("Definitions").first()).toBeVisible();
    await expect(page.getByText("src/auth.ts").first()).toBeVisible();
  });

  test("admin page exposes daemon-wide controls only and links to projects", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    // Workspace-wide controls.
    await expect(page.getByRole("button", { name: /index all projects/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /refresh \(reconcile drift\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /reset index/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^restart$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^stop$/ })).toBeVisible();
    // Per-project actions moved to /projects — admin should NOT show
    // a row for each fixture project.
    await expect(page.getByRole("row").filter({ hasText: "demo" })).toHaveCount(0);
    // The intro paragraph links to /projects so users know where the
    // per-project controls went. (There are multiple "projects" links —
    // nav + this one — so check there are at least 2 and that the
    // subtitle mentions where to go.)
    await expect(page.getByRole("link", { name: "projects" }).first()).toBeVisible();
    await expect(page.getByText(/Per-project actions/)).toBeVisible();
  });

  test("admin: index all triggers /api/index and reports success", async ({ page }) => {
    await page.goto("/admin");
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/index") && r.request().method() === "POST",
      ),
      page.getByRole("button", { name: /index all projects/ }).click(),
    ]);
    expect(response.status()).toBe(200);
    await expect(page.getByText(/index all: ok/)).toBeVisible();
  });

  test("nav exposes every route", async ({ page }) => {
    await page.goto("/");
    for (const label of [
      "dashboard",
      "projects",
      "search",
      "find-usages",
      "doctor",
      "models",
      "config",
      "admin",
    ]) {
      await expect(page.getByRole("link", { name: label })).toBeVisible();
    }
  });

  test("dashboard renders the floating section nav with one active dot", async ({ page }) => {
    // Use a desktop viewport — the nav is hidden below 980px.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Page sections" });
    await expect(nav).toBeVisible();
    // Six dashboard sections.
    await expect(nav.locator(".section-nav-item")).toHaveCount(6);
    // Exactly one is the active (elongated) marker.
    await expect(nav.locator(".section-nav-item.active")).toHaveCount(1);
  });

  test("SPA hard reload at a deep route still renders the correct page", async ({ page }) => {
    // Hits the SPA fallback in the Hono server: /admin should serve
    // index.html, then react-router takes over and renders AdminPage.
    await page.goto("/admin");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  });

  test("projects page surfaces watcher state and per-project actions", async ({ page }) => {
    await page.goto("/projects");
    // Fixture runs --no-watch so the watcher cell shows "—" and only the
    // recrawl + purge buttons appear (pause/resume are hidden when no
    // watcher is registered for the row).
    const row = page.getByRole("row").filter({ hasText: "demo" }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "recrawl" })).toBeVisible();
    await expect(row.getByRole("button", { name: "purge" })).toBeVisible();
    await expect(row.getByRole("button", { name: "pause" })).toHaveCount(0);
  });

  test("projects page renders a path under each project name", async ({ page }) => {
    // Single-project fixture: no commonRoot aggregation, but the path
    // sub-line should still render (either the absolute /tmp/.. form
    // or a ~/-abbreviated form).
    await page.goto("/projects");
    const row = page.getByRole("row").filter({ hasText: "demo" }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(/loctx-pw-fixture\/demo/)).toBeVisible();
  });

  test("projects page recrawl button hits /api/index", async ({ page }) => {
    await page.goto("/projects");
    const row = page.getByRole("row").filter({ hasText: "demo" }).first();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/index") && r.request().method() === "POST"),
      row.getByRole("button", { name: "recrawl" }).click(),
    ]);
    expect(response.status()).toBe(200);
    // Reload + the surface message becomes visible.
    await expect(page.getByText(/recrawl demo: ok/)).toBeVisible();
  });

  test("watchers endpoint reports an empty list under --no-watch", async ({ request }) => {
    const r = await request.get("/api/watchers");
    expect(r.status()).toBe(200);
    const body = (await r.json()) as { enabled: boolean; entries: unknown[] };
    expect(body.enabled).toBe(false);
    expect(body.entries).toEqual([]);
  });

  test("watch pause endpoint refuses when the daemon was started with --no-watch", async ({
    request,
  }) => {
    const r = await request.post("/api/watch/pause", { data: { projectId: "anything" } });
    expect(r.status()).toBe(409);
  });

  test("rejects API requests with a mismatched Host header (DNS-rebinding guard)", async ({
    request,
  }) => {
    const r = await request.get("/api/status", {
      headers: { Host: "evil.example.com" },
    });
    expect(r.status()).toBe(403);
  });

  test("rejects API requests with a cross-origin Origin (CSRF guard)", async ({ request }) => {
    const r = await request.post("/api/reset/index", {
      data: {},
      headers: {
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
      },
    });
    expect(r.status()).toBe(403);
  });

  test("rejects /mcp with a hostile Origin", async ({ request }) => {
    const r = await request.post("/mcp", {
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "csrf", version: "1" },
        },
      },
      headers: {
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    });
    expect(r.status()).toBe(403);
  });

  test("MCP endpoint at /mcp responds (smoke check via fetch)", async ({ request }) => {
    const response = await request.post("/mcp", {
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "playwright", version: "1" },
        },
      },
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    });
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('"name":"loctx"');
  });
});
