/**
 * HTTP client for talking to the running loctx daemon from short-lived
 * CLI processes. Reads the lock file for hostname:port; throws when no
 * daemon is up so callers can decide whether to fall back to local
 * execution.
 */

import { readActiveDaemon } from "./daemon-lock.js";

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
  const base = `http://${lock.hostname ?? "localhost"}:${lock.port}`;

  const fetchJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const r = await fetch(`${base}${path}`, init);
    const text = await r.text();
    if (!r.ok) throw new DaemonHttpError(r.status, text);
    return text === "" ? (undefined as T) : (JSON.parse(text) as T);
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
