/**
 * Thin fetch wrappers. Centralised so a future auth header or base-path
 * change touches one file.
 */

import type {
  ConfigPayload,
  DoctorPayload,
  FindUsagesPayload,
  FindUsagesRequest,
  ModelsPayload,
  ProjectsPayload,
  SearchPayload,
  SearchRequestBody,
  StatusPayload,
  WatchersPayload,
} from "@shared/contracts";

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return (await r.json()) as T;
}

export const api = {
  status: () => getJson<StatusPayload>("/api/status"),
  projects: () => getJson<ProjectsPayload>("/api/projects"),
  search: (body: SearchRequestBody) => postJson<SearchPayload>("/api/search", body),
  doctor: () => getJson<DoctorPayload>("/api/doctor"),
  config: () => getJson<ConfigPayload>("/api/config"),
  models: () => getJson<ModelsPayload>("/api/models"),
  modelUse: (name: string, project = false) =>
    postJson<{ ok: true; target: string; reindexRequired: boolean; message: string }>(
      "/api/models/use",
      { name, project },
    ),
  modelDownload: (name: string) =>
    postJson<{ ok: true; name: string }>("/api/models/download", { name }),
  findUsages: (body: FindUsagesRequest) =>
    postJson<FindUsagesPayload>("/api/find-usages", body),
  index: (path?: string) =>
    postJson<{
      ok: true;
      summaries: Array<{
        projectId: string;
        name: string;
        indexed: number;
        skipped: number;
        failed: number;
        elapsedSeconds: number;
      }>;
    }>("/api/index", path !== undefined ? { path } : {}),
  refresh: () =>
    postJson<{
      ok: true;
      summaries: Array<{ projectId: string; name: string; pruned: number; reindexed: number }>;
    }>("/api/refresh", {}),
  resetIndex: () => postJson<{ ok: true; cleared: string[] }>("/api/reset/index", {}),
  resetProject: (path: string) =>
    postJson<{ ok: true; project: { id: string; name: string; root: string } }>(
      "/api/reset/project",
      { path },
    ),
  activateProject: (path: string) =>
    postJson<{
      ok: true;
      project: { id: string; name: string; root: string };
      indexed: number;
      skipped: number;
      failed: number;
    }>("/api/projects/activate", { path }),
  deactivateProject: (path: string) =>
    postJson<{ ok: true; project: { id: string; name: string; root: string } }>(
      "/api/projects/deactivate",
      { path },
    ),
  restart: () =>
    postJson<{ ok: true; stopped: number; message: string }>("/api/restart", {}),
  stop: () => postJson<{ ok: true; stopped: number }>("/api/stop", {}),
  watchers: () => getJson<WatchersPayload>("/api/watchers"),
  watchPause: (projectId: string) =>
    postJson<{ ok: true; paused: string; state: string }>("/api/watch/pause", { projectId }),
  watchResume: (projectId: string) =>
    postJson<{ ok: true; resumed: string; state: string }>("/api/watch/resume", { projectId }),
};
