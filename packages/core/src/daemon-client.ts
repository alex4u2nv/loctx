/**
 * HTTP client for talking to the running loctx daemon from short-lived
 * CLI processes. Reads the lock file for hostname:port; throws when no
 * daemon is up so callers can decide whether to fall back to local
 * execution.
 */

import { readActiveDaemon } from "./daemon-lock.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    // A bad env var should not silently quantize to setTimeout's 1ms
    // floor and fail every single request. Warn once and use the
    // default instead.
    console.error(
      `[loctx] ignoring invalid LOCTX_DAEMON_TIMEOUT_MS=${raw} (not a positive integer); using ${DEFAULT_TIMEOUT_MS}ms.`,
    );
    return DEFAULT_TIMEOUT_MS;
  }
  return n;
}

export class NoDaemonError extends Error {
  constructor() {
    super("no active loctx daemon (start one with `loctx start`)");
  }
}

export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`daemon responded ${status}: ${body}`);
  }
}

export interface DaemonClient {
  readonly base: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export function daemonClient(dataDir: string): DaemonClient {
  const lock = readActiveDaemon(dataDir);
  if (lock === null || lock.port === undefined) throw new NoDaemonError();
  // Fall back to the literal loopback IP (not the name) when the lock
  // file lacks a hostname. Browsers refuse to DNS-rebind a literal IP,
  // which is the whole point of the daemon binding 127.0.0.1 by default;
  // resolving "localhost" via DNS would re-open the rebinding attack
  // surface for any CLI tool talking to a misconfigured lock file
  // (closes #171).
  const base = `http://${lock.hostname ?? "127.0.0.1"}:${lock.port}`;

  // Cap any single CLI ↔ daemon request. A wedged handler (or a
  // hot-reload glitch with the HTTP listener still accepting but never
  // responding) shouldn't hang `loctx search` indefinitely. 30s is
  // enough headroom for cold-search on a large workspace; everything
  // else completes in <1s. Override via LOCTX_DAEMON_TIMEOUT_MS for
  // long-running endpoints under test.
  const timeoutMs = parseTimeoutMs(process.env["LOCTX_DAEMON_TIMEOUT_MS"]);

  const fetchJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, { ...init, signal: ctrl.signal });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new DaemonHttpError(
          504,
          `request to ${path} exceeded ${timeoutMs}ms (LOCTX_DAEMON_TIMEOUT_MS to raise)`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const text = await r.text();
    if (!r.ok) throw new DaemonHttpError(r.status, text);
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A 2xx with a non-JSON body usually means an HTTP proxy got
      // between the CLI and the daemon (corporate intercept, dev
      // reverse-proxy) and rewrote the response. Surface the first
      // 200 chars so the user can see what's actually coming back
      // instead of getting a SyntaxError stack from the CLI.
      const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      throw new DaemonHttpError(r.status, `non-JSON response from ${path}: ${preview}`);
    }
  };

  return {
    base,
    get: <T>(path: string) => fetchJson<T>(path),
    post: <T>(path: string, body?: unknown) =>
      fetchJson<T>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? "{}" : JSON.stringify(body),
      }),
  };
}
