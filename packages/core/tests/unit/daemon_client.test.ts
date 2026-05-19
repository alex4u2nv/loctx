/**
 * daemon-client behaviors that hide behind the lockfile + fetch boundary:
 *
 * - timeout → DaemonHttpError(504) so the CLI's pretty-printer renders
 *   a one-liner instead of hanging or dumping a stack
 * - server returns non-2xx → DaemonHttpError carries status + body
 * - no lockfile → NoDaemonError
 *
 * Uses a real loopback http server to exercise the AbortController
 * path; mocking fetch wouldn't catch the actual timer/abort wiring.
 */

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonHttpError, NoDaemonError, daemonClient } from "../../src/daemon-client.js";
import { acquireDaemonLock } from "../../src/daemon-lock.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let server: Server | null = null;

beforeEach(() => {
  tmp = mkTmpDir();
});
afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  rmTmpDir(tmp);
});

function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server?.address() as AddressInfo).port;
      resolve(port);
    });
  });
}

async function writeLock(port: number): Promise<void> {
  acquireDaemonLock(tmp, {
    pid: process.pid,
    port,
    hostname: "127.0.0.1",
    startedAt: new Date().toISOString(),
    version: "test",
  });
}

describe("daemonClient", () => {
  it("throws NoDaemonError when no lockfile is present", () => {
    expect(() => daemonClient(tmp)).toThrow(NoDaemonError);
  });

  it("returns DaemonHttpError carrying status + body on non-2xx", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(409, { "content-type": "text/plain" });
      res.end("reconciler running");
    });
    await writeLock(port);
    const client = daemonClient(tmp);
    await expect(client.get("/api/whatever")).rejects.toMatchObject({
      constructor: DaemonHttpError,
      status: 409,
      body: "reconciler running",
    });
  });

  it("falls back to default timeout when LOCTX_DAEMON_TIMEOUT_MS is non-numeric", async () => {
    // Server responds promptly so we can verify the bad env doesn't
    // collapse to setTimeout's 1ms floor. If parseTimeoutMs failed
    // open, the request would abort before the response landed.
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await writeLock(port);
    const prev = process.env["LOCTX_DAEMON_TIMEOUT_MS"];
    process.env["LOCTX_DAEMON_TIMEOUT_MS"] = "abc";
    const origErr = console.error;
    console.error = () => {};
    try {
      const client = daemonClient(tmp);
      await expect(client.get("/api/ok")).resolves.toEqual({ ok: true });
    } finally {
      console.error = origErr;
      // biome-ignore lint/performance/noDelete: env var must be absent to test the production default
      if (prev === undefined) delete process.env["LOCTX_DAEMON_TIMEOUT_MS"];
      else process.env["LOCTX_DAEMON_TIMEOUT_MS"] = prev;
    }
  });

  it("rejects with DaemonHttpError when a 200 body is not JSON", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>proxy got in the middle</html>");
    });
    await writeLock(port);
    const client = daemonClient(tmp);
    await expect(client.get("/api/status")).rejects.toMatchObject({
      constructor: DaemonHttpError,
      status: 200,
    });
  });

  it("times out via AbortController and surfaces DaemonHttpError(504)", async () => {
    // Server that never writes a response — would hang fetch forever
    // without the client-side abort.
    const port = await listen(() => {
      /* intentionally drop the request on the floor */
    });
    await writeLock(port);
    const prev = process.env["LOCTX_DAEMON_TIMEOUT_MS"];
    process.env["LOCTX_DAEMON_TIMEOUT_MS"] = "150";
    try {
      const client = daemonClient(tmp);
      await expect(client.get("/api/sleep")).rejects.toMatchObject({
        constructor: DaemonHttpError,
        status: 504,
      });
    } finally {
      // biome-ignore lint/performance/noDelete: env var must be absent to test the production default
      if (prev === undefined) delete process.env["LOCTX_DAEMON_TIMEOUT_MS"];
      else process.env["LOCTX_DAEMON_TIMEOUT_MS"] = prev;
    }
  });
});
