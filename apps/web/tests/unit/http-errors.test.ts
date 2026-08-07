/**
 * http-errors.ts — the SRV-3 error boundary: typed HttpErrors map to
 * their JSON body + status, unexpected throws are sanitized to an
 * opaque 500, and jsonBody is the single JSON-parse guard.
 */

import { type Context, Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestError,
  ForbiddenError,
  HttpError,
  jsonBody,
  jsonBodyOrEmpty,
  registerErrorBoundary,
} from "../../server/lib/http-errors.js";

afterEach(() => vi.restoreAllMocks());

function appWithBoundary(handler: (c: Context) => Promise<Response> | Response): Hono {
  const app = new Hono();
  registerErrorBoundary(app);
  app.post("/t", handler);
  return app;
}

async function post(app: Hono, body?: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request("/t", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body } : {}),
  });
  return { status: res.status, body: await res.json() };
}

describe("registerErrorBoundary", () => {
  it("maps a thrown HttpError to { error } with its status", async () => {
    const app = appWithBoundary(() => {
      throw new HttpError(409, "already running");
    });
    const { status, body } = await post(app, "{}");
    expect(status).toBe(409);
    expect(body).toEqual({ error: "already running" });
  });

  it("maps BadRequestError to 400 and ForbiddenError to 403", async () => {
    const bad = appWithBoundary(() => {
      throw new BadRequestError("nope");
    });
    expect((await post(bad, "{}")).status).toBe(400);

    const forbidden = appWithBoundary(() => {
      throw new ForbiddenError("path is not under any configured workspace_root");
    });
    const { status, body } = await post(forbidden, "{}");
    expect(status).toBe(403);
    expect(body).toEqual({ error: "path is not under any configured workspace_root" });
  });

  it("sanitizes an unexpected throw to an opaque 500 (no internals leaked)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = appWithBoundary(() => {
      throw new Error("/Users/alex/secret/path exploded");
    });
    const { status, body } = await post(app, "{}");
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: "internal_error", code: "unhandled" });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(spy).toHaveBeenCalled();
  });
});

describe("jsonBody", () => {
  const echo = () =>
    appWithBoundary(async (c) => {
      const body = await jsonBody(c);
      return c.json(body);
    });

  it("returns the parsed object on a valid JSON object body", async () => {
    const { status, body } = await post(echo(), JSON.stringify({ a: 1 }));
    expect(status).toBe(200);
    expect(body).toEqual({ a: 1 });
  });

  it("400s the uniform shape on malformed JSON", async () => {
    const { status, body } = await post(echo(), "{ not json");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid JSON body" });
  });

  it("400s on a missing body", async () => {
    const { status, body } = await post(echo());
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid JSON body" });
  });

  it("400s on non-object JSON payloads (array, number, null)", async () => {
    expect((await post(echo(), "[1,2]")).status).toBe(400);
    expect((await post(echo(), "5")).status).toBe(400);
    expect((await post(echo(), "null")).status).toBe(400);
  });
});

describe("jsonBodyOrEmpty", () => {
  const echo = () =>
    appWithBoundary(async (c) => {
      const body = await jsonBodyOrEmpty(c);
      return c.json(body);
    });

  it("treats a missing/whitespace body as {} (trigger-endpoint convention)", async () => {
    expect(await post(echo())).toEqual({ status: 200, body: {} });
    expect(await post(echo(), "  \n")).toEqual({ status: 200, body: {} });
  });

  it("still parses a real object body and 400s on malformed/non-object JSON", async () => {
    expect(await post(echo(), JSON.stringify({ path: "/ws" }))).toEqual({
      status: 200,
      body: { path: "/ws" },
    });
    expect((await post(echo(), "{ not json")).status).toBe(400);
    expect((await post(echo(), "[1]")).status).toBe(400);
  });
});
