/**
 * Concurrent-GET dedupe (#456). The dashboard mounts two consumers of
 * `/api/status` (the header StatusChip and the status page); before the
 * dedupe in api.ts they raced two identical requests on every load.
 */

import { expect, test } from "@playwright/test";

test("dashboard load issues exactly one /api/status request (#456)", async ({ page }) => {
  const statusRequests: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/api/status") statusRequests.push(req.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Index\s+Flow/ })).toBeVisible();

  expect(statusRequests).toHaveLength(1);
});
