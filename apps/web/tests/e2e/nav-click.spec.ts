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
  // doctor is an Admin sub-tab now; the global nav exposes "admin".
  await page.getByRole("link", { name: "admin" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible({ timeout: 5000 });
});

test("navigated page content is revealed, not left blank at opacity:0 (#438)", async ({ page }) => {
  // Scroll-reveal tags every .card with data-reveal (opacity:0) and only the
  // reveal controller flips it to .reveal-visible. A zero-size measurement
  // during the lazy-route mount used to leave above-the-fold cards stuck
  // hidden on a non-scrolling page — a blank page until reload. NB: Playwright
  // treats opacity:0 as "visible", so we assert the reveal class explicitly.
  await page.goto("/");
  await page.getByRole("link", { name: "admin" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  const firstCard = page.locator(".card").first();
  await expect(firstCard).toHaveClass(/reveal-visible/, { timeout: 5000 });
});

test("stale /assets/*.js requests 404 instead of returning HTML", async ({ request }) => {
  // The SPA fallback used to serve index.html for any unmatched GET,
  // including stale asset hashes — silently corrupting module loads.
  const r = await request.get("/assets/projects-OLDHASH.js");
  expect(r.status()).toBe(404);
  expect(r.headers()["content-type"]).not.toContain("text/html");
});
