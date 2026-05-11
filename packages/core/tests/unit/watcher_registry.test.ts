import { describe, expect, it } from "vitest";
import { type ProjectId, projectId } from "../../src/models.js";
import { WatcherRegistry } from "../../src/watcher/registry.js";
import type { WatcherService } from "../../src/watcher/service.js";

function fakeWatcher(): {
  service: WatcherService;
  pauseCalls: number;
  resumeCalls: number;
} {
  let pauseCalls = 0;
  let resumeCalls = 0;
  const service = {
    pause: () => {
      pauseCalls += 1;
    },
    resume: () => {
      resumeCalls += 1;
    },
  } as unknown as WatcherService;
  return {
    service,
    get pauseCalls() {
      return pauseCalls;
    },
    get resumeCalls() {
      return resumeCalls;
    },
  };
}

const id = (raw: string): ProjectId => projectId(raw);

describe("WatcherRegistry", () => {
  it("registers an entry as active by default", () => {
    const reg = new WatcherRegistry();
    const w = fakeWatcher();
    reg.register({
      projectId: id("p1"),
      projectName: "demo",
      projectRoot: "/tmp/demo",
      watcher: w.service,
      startedAt: "2026-01-01T00:00:00Z",
    });
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("active");
    expect(list[0]?.failureReason).toBeNull();
  });

  it("pause flips state and forwards to the underlying watcher", () => {
    const reg = new WatcherRegistry();
    const w = fakeWatcher();
    reg.register({
      projectId: id("p1"),
      projectName: "demo",
      projectRoot: "/tmp/demo",
      watcher: w.service,
      startedAt: "2026-01-01T00:00:00Z",
    });
    const entry = reg.pause(id("p1"));
    expect(entry?.state).toBe("paused");
    expect(w.pauseCalls).toBe(1);
  });

  it("resume clears any prior failure and unpauses the watcher", () => {
    const reg = new WatcherRegistry();
    const w = fakeWatcher();
    reg.register({
      projectId: id("p1"),
      projectName: "demo",
      projectRoot: "/tmp/demo",
      watcher: w.service,
      startedAt: "2026-01-01T00:00:00Z",
    });
    reg.markFailed(id("p1"), "out of file descriptors");
    expect(reg.get(id("p1"))?.state).toBe("failed");

    const entry = reg.resume(id("p1"));
    expect(entry?.state).toBe("active");
    expect(entry?.failureReason).toBeNull();
    expect(w.resumeCalls).toBe(1);
  });

  it("returns null when pausing or resuming an unknown project", () => {
    const reg = new WatcherRegistry();
    expect(reg.pause(id("ghost"))).toBeNull();
    expect(reg.resume(id("ghost"))).toBeNull();
  });

  it("list returns snapshots that don't expose the underlying service", () => {
    const reg = new WatcherRegistry();
    const w = fakeWatcher();
    reg.register({
      projectId: id("p1"),
      projectName: "demo",
      projectRoot: "/tmp/demo",
      watcher: w.service,
      startedAt: "2026-01-01T00:00:00Z",
    });
    const snapshot = reg.list()[0];
    expect(snapshot).not.toHaveProperty("watcher");
  });
});
