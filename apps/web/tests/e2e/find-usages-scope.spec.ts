/**
 * Nested-package scope resolution over REST (#449, #276).
 *
 * The fixture's demo project absorbs `packages/inner` (own package.json,
 * no index rows of its own). Before #449, /api/find-usages resolved a
 * path inside the inner package to the EMPTY inner project and silently
 * returned zero hits — while the same path through the MCP tool widened
 * to the indexed parent. Both now share core's findSymbolUsages.
 */

import { join } from "node:path";
import { expect, test } from "@playwright/test";

const FIXTURE_ROOT = process.env["LOCTX_PW_FIXTURE"] ?? "/tmp/loctx-pw-fixture";

test("find-usages scoped inside a nested unindexed package widens to the indexed parent (#449)", async ({
  request,
}) => {
  const innerPath = join(FIXTURE_ROOT, "demo", "packages", "inner", "src");
  const res = await request.post("/api/find-usages", {
    data: { symbol: "authenticate", path: innerPath },
  });
  expect(res.status()).toBe(200);
  const payload = (await res.json()) as {
    defs: Array<{ relPath: string }>;
    refs: Array<{ relPath: string }>;
    warnings: string[];
  };

  // The def lives in the parent's src/auth.ts — reachable only because
  // the scope widened past the inner marker.
  expect(payload.defs.map((d) => d.relPath)).toContain("src/auth.ts");
  expect(payload.warnings.join(" ")).toContain("unindexed inner project");
});

test("find-usages with a path outside every indexed project still 404s", async ({ request }) => {
  const res = await request.post("/api/find-usages", {
    data: { symbol: "authenticate", path: FIXTURE_ROOT },
  });
  expect(res.status()).toBe(404);
});
