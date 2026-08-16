import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isVerbose, safeLog } from "../../src/log.js";

let stderr: string[] = [];
let stub: ReturnType<typeof vi.spyOn> | null = null;
const originalLog = process.env["LOCTX_LOG"];

beforeEach(() => {
  stderr = [];
  stub = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
    stderr.push(String(msg));
  });
});

afterEach(() => {
  stub?.mockRestore();
  if (originalLog === undefined) Reflect.deleteProperty(process.env, "LOCTX_LOG");
  else process.env["LOCTX_LOG"] = originalLog;
});

describe("safeLog", () => {
  it("prints info messages without a level prefix", () => {
    safeLog("info", "hello");
    expect(stderr[0]).toBe("hello");
  });

  it("prefixes warn and error", () => {
    safeLog("warn", "be careful");
    safeLog("error", "boom");
    expect(stderr[0]).toBe("[warn] be careful");
    expect(stderr[1]).toBe("[error] boom");
  });

  it("drops debug messages unless LOCTX_LOG=debug", () => {
    safeLog("debug", "nope");
    expect(stderr).toEqual([]);
  });

  it("emits debug when LOCTX_LOG=debug", () => {
    process.env["LOCTX_LOG"] = "debug";
    safeLog("debug", "ok");
    expect(stderr[0]).toBe("[debug] ok");
  });

  it("rewrites absolute paths inside projectRoot to <project>/relative", () => {
    safeLog("info", "Indexing /tmp/repo/src/auth.ts now", { projectRoot: "/tmp/repo" });
    expect(stderr[0]).toContain("<project>/src/auth.ts");
    expect(stderr[0]).not.toContain("/tmp/repo/src/auth.ts");
  });

  it("rewrites paths outside projectRoot to <external>/<parent>/<basename> (#156)", () => {
    // Last-two-segments scrubbing balances privacy with debuggability —
    // bare basename drops the originating directory, making it hard to
    // tell which tool produced the message.
    safeLog("info", "Skipping /etc/passwd", { projectRoot: "/tmp/repo" });
    expect(stderr[0]).toContain("<external>/etc/passwd");
    expect(stderr[0]).not.toContain("/etc/passwd ");

    safeLog("info", "Tool error /Users/you/.config/loctx/file.yaml", {
      projectRoot: "/tmp/repo",
    });
    expect(stderr[1]).toContain("<external>/loctx/file.yaml");
  });

  it("summarizes large or multi-line messages", () => {
    const big = "x".repeat(2000);
    safeLog("info", big);
    expect(stderr[0]).toContain("2000-byte message");
    expect(stderr[0]).toContain("LOCTX_LOG=debug");
  });

  it("prints messages verbatim when raw is set", () => {
    safeLog("info", "/tmp/repo/secret.txt", { projectRoot: "/tmp/repo", raw: true });
    expect(stderr[0]).toBe("/tmp/repo/secret.txt");
  });

  it("isVerbose reflects the env var", () => {
    Reflect.deleteProperty(process.env, "LOCTX_LOG");
    expect(isVerbose()).toBe(false);
    process.env["LOCTX_LOG"] = "debug";
    expect(isVerbose()).toBe(true);
  });
});
