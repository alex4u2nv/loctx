import { type Config, runDoctorChecks, type WatcherRegistry, worstStatus } from "@loctx/core";
import type { Hono } from "hono";
import type { DoctorPayload } from "../../shared/contracts.js";

export function mountDoctor(app: Hono, config: Config, watcherRegistry?: WatcherRegistry): void {
  app.get("/api/doctor", async (c) => {
    const checks = await runDoctorChecks(
      config,
      watcherRegistry !== undefined ? { watcherRegistry } : {},
    );
    const payload: DoctorPayload = {
      checks: checks.map((ch) => ({ name: ch.name, status: ch.status, detail: ch.detail })),
      summary: worstStatus(checks),
    };
    return c.json(payload);
  });
}
