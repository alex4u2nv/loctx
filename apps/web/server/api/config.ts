import type { Config } from "@loctx/core";
import type { Hono } from "hono";
import type { ConfigPayload } from "../../shared/contracts.js";

export function mountConfig(app: Hono, config: Config): void {
  app.get("/api/config", (c) => {
    // Strip the deeply-frozen wrapper so the JSON serialiser sees a plain
    // object. We don't want to leak the frozen markers; the wire payload
    // is read-only at the consumer end anyway.
    const payload: ConfigPayload = {
      raw: deepClone(config),
      globalSource: config.source,
      projectSource: config.projectSource,
    };
    return c.json(payload);
  });
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
