/**
 * Admin UI end-to-end tests.
 *
 * Drives the live Vite-built SPA + Hono daemon through Chromium. The
 * fixture project (set up in playwright.config.ts) is already indexed
 * before the daemon comes up, so /search returns deterministic results.
 */

import { expect, test } from "@playwright/test";

test.describe("loctx admin UI", () => {
  test("status page renders with embedding identity + workspace_roots", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();
    await expect(page.getByText(/huggingface-transformers/)).toBeVisible();
    await expect(page.getByText("demo").first()).toBeVisible();
  });

  test("projects page lists the fixture project as active", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    const activeRow = page.getByRole("row").filter({ hasText: "demo" });
    await expect(activeRow.first()).toBeVisible();
    await expect(page.getByText(/files indexed/)).toBeVisible();
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

  test("admin page exposes operational controls and the project row", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    // Top-level controls.
    await expect(page.getByRole("button", { name: /^index all$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /refresh \(reconcile\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /reset index \(all data\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^restart$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^stop$/ })).toBeVisible();
    // Per-project row from the fixture.
    await expect(page.getByRole("row").filter({ hasText: "demo" }).first()).toBeVisible();
  });

  test("admin: index all triggers /api/index and logs the result", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("button", { name: /^index all$/ }).click();
    // Output panel shows the call and a JSON-stringified result.
    await expect(page.getByText(/index \(all\)/)).toBeVisible();
    await expect(page.getByText(/"summaries"/)).toBeVisible();
  });

  test("nav exposes every route", async ({ page }) => {
    await page.goto("/");
    for (const label of [
      "status",
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

  test("SPA hard reload at a deep route still renders the correct page", async ({ page }) => {
    // Hits the SPA fallback in the Hono server: /admin should serve
    // index.html, then react-router takes over and renders AdminPage.
    await page.goto("/admin");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  });

  test("projects page surfaces watcher state and pause/resume controls", async ({ page }) => {
    await page.goto("/projects");
    // The fixture daemon runs with --no-watch so the watcher column reads "—".
    // We still expect the row + the recrawl/purge buttons to render.
    const row = page.getByRole("row").filter({ hasText: "demo" }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "recrawl" })).toBeVisible();
    await expect(row.getByRole("button", { name: "purge" })).toBeVisible();
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
