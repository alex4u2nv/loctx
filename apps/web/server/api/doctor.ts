import { type Config, runDoctorChecks, worstStatus } from "@loctx/core";
import type { Hono } from "hono";
import type { DoctorPayload } from "../../shared/contracts.js";

export function mountDoctor(app: Hono, config: Config): void {
  app.get("/api/doctor", async (c) => {
    const checks = await runDoctorChecks(config);
    const payload: DoctorPayload = {
      checks: checks.map((ch) => ({ name: ch.name, ok: ch.status === "ok", detail: ch.detail })),
      summary: worstStatus(checks),
    };
    return c.json(payload);
  });
}
