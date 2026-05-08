import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function mkTmpDir(prefix = "loctx-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function rmTmpDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
