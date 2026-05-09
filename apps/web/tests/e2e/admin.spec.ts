/**
 * Admin UI end-to-end tests.
 *
 * Drives the live Next.js admin UI through Chromium. The fixture
 * project (set up in global-setup.ts) is already indexed before the
 * daemon comes up, so /search returns deterministic results.
 */

import { expect, test } from "@playwright/test";

test.describe("loctx admin UI", () => {
  test("status page renders with embedding identity + workspace_roots", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();
    // Status page reads embedding info from the static config, not the
    // runtime override; the fake-provider override only swaps the
    // provider instance, not the displayed identity.
    await expect(page.getByText(/huggingface-transformers/)).toBeVisible();
    // The fixture project is discoverable.
    await expect(page.getByText("demo").first()).toBeVisible();
  });

  test("projects page lists the fixture project as active", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    // Active table contains "demo".
    const activeRow = page.getByRole("row").filter({ hasText: "demo" });
    await expect(activeRow.first()).toBeVisible();
    // The "files" column for demo should be > 0 (we indexed 2 source files).
    await expect(page.getByText(/files indexed/)).toBeVisible();
  });

  test("search returns the indexed auth chunk", async ({ page }) => {
    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();

    // Submit a query that matches a token in the fixture.
    await page.getByLabel("query").fill("authentication");
    await page.getByRole("button", { name: "Search" }).click();

    // Results region appears with at least one hit referencing src/auth.ts.
    await expect(page.getByText(/result/i).first()).toBeVisible();
    await expect(page.getByText("src/auth.ts").first()).toBeVisible();
  });

  test("scope label reflects project when search is scoped to a path", async ({ page }) => {
    await page.goto(`/search?q=rate+limit&path=${encodeURIComponent("/tmp/loctx-pw-fixture/demo")}`);
    // The scope summary line includes 'scope:' followed by the mode.
    // Use a more specific locator since the page also has a 'subtitle'
    // paragraph that mentions "Scope".
    await expect(page.getByText(/scope:/i).first()).toBeVisible();
    // The result list should reference the project.
    await expect(page.getByText("demo").first()).toBeVisible();
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
    // Response is SSE; the data line carries the JSON payload.
    expect(text).toContain('"name":"loctx"');
  });
});
