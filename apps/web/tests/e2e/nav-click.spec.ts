/**
 * Regression: clicking a nav link must update the rendered route, not
 * just the URL bar. Previously failed under reconciliation pressure
 * because SSE-driven re-renders interrupted React Router v7's
 * navigation transition (#249).
 */
import { expect, test } from "@playwright/test";

test("clicking a NavLink swaps the rendered route", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 5000 });
  await page.getByRole("link", { name: "doctor" }).click();
  await expect(page).toHaveURL(/\/doctor$/);
  await expect(page.getByRole("heading", { name: /doctor/i })).toBeVisible({ timeout: 5000 });
});

test("stale /assets/*.js requests 404 instead of returning HTML", async ({ request }) => {
  // The SPA fallback used to serve index.html for any unmatched GET,
  // including stale asset hashes — silently corrupting module loads.
  const r = await request.get("/assets/projects-OLDHASH.js");
  expect(r.status()).toBe(404);
  expect(r.headers()["content-type"]).not.toContain("text/html");
});
