import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectId } from "../../src/models.js";
import { HEALTH_HISTORY_KEEP, StateStore } from "../../src/storage/state.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let state: StateStore;
beforeEach(() => {
  tmp = mkTmpDir();
  state = new StateStore(join(tmp, "state.sqlite3"));
});
afterEach(() => {
  state.close();
  rmTmpDir(tmp);
});

const p1 = projectId("p1");
const p2 = projectId("p2");
const snap = (id: typeof p1, at: string, score: number, payload = `{"score":${score}}`) => ({
  projectId: id,
  computedAt: at,
  version: 1,
  score,
  grade: score >= 80 ? "B" : "C",
  payloadJson: payload,
});

describe("project_health snapshots", () => {
  it("appends only when the payload changed and lists newest first", () => {
    expect(state.recordProjectHealth(snap(p1, "2026-01-01T00:00:00Z", 80))).toBe(true);
    expect(state.recordProjectHealth(snap(p1, "2026-01-02T00:00:00Z", 80))).toBe(false);
    expect(state.recordProjectHealth(snap(p1, "2026-01-03T00:00:00Z", 75))).toBe(true);
    const rows = state.listProjectHealth(p1, 10);
    expect(rows.map((r) => [r.computedAt, r.score, r.grade])).toEqual([
      ["2026-01-03T00:00:00Z", 75, "C"],
      ["2026-01-01T00:00:00Z", 80, "B"],
    ]);
    expect(state.listProjectHealth(p1, 1)).toHaveLength(1);
  });

  it("a model-version bump re-records an otherwise identical payload", () => {
    expect(state.recordProjectHealth(snap(p1, "2026-01-01T00:00:00Z", 80))).toBe(true);
    expect(state.recordProjectHealth({ ...snap(p1, "2026-01-02T00:00:00Z", 80), version: 2 })).toBe(
      true,
    );
  });

  it("recentProjectHealth groups per project, newest first, capped", () => {
    for (const [at, score] of [
      ["2026-01-01T00:00:00Z", 60],
      ["2026-01-02T00:00:00Z", 70],
      ["2026-01-03T00:00:00Z", 90],
    ] as const) {
      state.recordProjectHealth(snap(p1, at, score));
    }
    state.recordProjectHealth(snap(p2, "2026-01-01T00:00:00Z", 85));
    const recent = state.recentProjectHealth(2);
    expect(recent.get(p1)?.map((r) => r.score)).toEqual([90, 70]);
    expect(recent.get(p2)?.map((r) => r.score)).toEqual([85]);
  });

  it("prunes each project's history to HEALTH_HISTORY_KEEP rows", () => {
    for (let i = 0; i < HEALTH_HISTORY_KEEP + 5; i += 1) {
      const at = `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
      state.recordProjectHealth(snap(p1, at, i % 2 === 0 ? 80 : 70));
    }
    const rows = state.listProjectHealth(p1, 1_000);
    expect(rows).toHaveLength(HEALTH_HISTORY_KEEP);
    expect(rows[0]?.computedAt).toBe("2026-01-01T00:01:44Z"); // i=104, the newest
  });

  it("deleteProject and purgeProjectContents drop the project's snapshots", () => {
    state.recordProjectHealth(snap(p1, "2026-01-01T00:00:00Z", 80));
    state.recordProjectHealth(snap(p2, "2026-01-01T00:00:00Z", 80));
    state.purgeProjectContents(p1);
    expect(state.listProjectHealth(p1, 10)).toEqual([]);
    state.deleteProject(p2);
    expect(state.listProjectHealth(p2, 10)).toEqual([]);
  });
});
