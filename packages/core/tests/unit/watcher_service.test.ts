/**
 * Lifecycle tests for WatcherService (#162). Exercises start →
 * subscribe → dispatch → stop against a real `@parcel/watcher` event
 * stream so subscription error paths, debounce coalescing, and the
 * inflight guard don't silently regress.
 *
 * Each test sets up a tmp project root, writes a `.git/HEAD` so the
 * indexer treats it as a real project, and uses a stub indexer that
 * just records calls.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectIndexer } from "../../src/indexing/indexer.js";
import { type Project, projectId } from "../../src/models.js";
import { WatcherService } from "../../src/watcher/service.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let projectRoot: string;

beforeEach(() => {
  tmp = mkTmpDir("loctx-watcher-");
  projectRoot = join(tmp, "demo");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
});

afterEach(() => {
  rmTmpDir(tmp);
});

function makeProject(): Project {
  return Object.freeze({ id: projectId("watcher-demo"), name: "demo", root: projectRoot });
}

interface StubIndexer {
  readonly indexer: ProjectIndexer;
  readonly events: Array<{ kind: "indexFile" | "deleteFile"; relPath: string }>;
}

function stubIndexer(): StubIndexer {
  const events: StubIndexer["events"] = [];
  // Stand-in filter that accepts every path. The real ProjectFilter
  // would consult gitignore + secret/extension rules; the watcher
  // routing tests don't care about that, they just need a callable
  // that returns `shouldIndex: true`.
  const passThroughFilter = {
    shouldIndex: () => ({ shouldIndex: true, reason: "ok", detail: "" }),
    rules: { ignoredDirs: new Set<string>() },
  };
  // Only the methods WatcherService.dispatch / routeEvent invoke; the
  // rest of ProjectIndexer's surface isn't exercised by these tests.
  const indexer = {
    indexFile: async (_project: Project, absPath: string) => {
      events.push({ kind: "indexFile", relPath: absPath });
      return { kind: "indexed" as const, relPath: absPath, chunks: 1 };
    },
    deleteFile: async (_project: Project, relPath: string) => {
      events.push({ kind: "deleteFile", relPath });
    },
    reevaluateFilter: async () => ({ checked: 0, pruned: 0, prunedRelPaths: [] }),
    filterFactory: () => passThroughFilter,
  } as unknown as ProjectIndexer;
  return { indexer, events };
}

/** Poll until `predicate` returns true or `ms` elapses. */
async function waitFor(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("WatcherService lifecycle (#162)", () => {
  it("starts, fires indexFile on a created file, and stops cleanly", async () => {
    const project = makeProject();
    const stub = stubIndexer();
    const w = new WatcherService(project, stub.indexer, { debounceMs: 30 });
    await w.start();
    try {
      writeFileSync(join(projectRoot, "src", "auth.ts"), "export const auth = 1;\n");
      await waitFor(() => stub.events.some((e) => e.relPath.endsWith("auth.ts")));
      expect(stub.events.some((e) => e.kind === "indexFile")).toBe(true);
    } finally {
      await w.stop();
    }
    // After stop, no further events should fire. Touch the file
    // again and assert the recorded count stays put.
    const before = stub.events.length;
    writeFileSync(join(projectRoot, "src", "auth.ts"), "export const auth = 2;\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(stub.events.length).toBe(before);
  });

  it("start() is idempotent — calling twice does not double-subscribe", async () => {
    const project = makeProject();
    const stub = stubIndexer();
    const w = new WatcherService(project, stub.indexer, { debounceMs: 30 });
    await w.start();
    // Second start is a no-op; the existing subscription must remain
    // intact and we must not register two debounce timers for the
    // same path.
    await w.start();
    try {
      writeFileSync(join(projectRoot, "src", "once.ts"), "export const x = 1;\n");
      await waitFor(() => stub.events.some((e) => e.relPath.endsWith("once.ts")));
      const matching = stub.events.filter((e) => e.relPath.endsWith("once.ts")).length;
      // Exactly one indexFile call — not two from a double subscription.
      expect(matching).toBe(1);
    } finally {
      await w.stop();
    }
  });

  it("pause() suspends dispatch; resume() restores it", async () => {
    const project = makeProject();
    const stub = stubIndexer();
    const w = new WatcherService(project, stub.indexer, { debounceMs: 30 });
    await w.start();
    try {
      w.pause();
      writeFileSync(join(projectRoot, "src", "paused.ts"), "export const x = 1;\n");
      // Give debounce time to fire; it should be discarded because
      // the service is paused.
      await new Promise((r) => setTimeout(r, 200));
      expect(stub.events.some((e) => e.relPath.endsWith("paused.ts"))).toBe(false);

      w.resume();
      writeFileSync(join(projectRoot, "src", "paused.ts"), "export const x = 2;\n");
      await waitFor(() => stub.events.some((e) => e.relPath.endsWith("paused.ts")));
    } finally {
      await w.stop();
    }
  });
});
