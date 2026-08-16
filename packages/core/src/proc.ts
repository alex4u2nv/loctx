/**
 * Shared promisified execFile (#543). The `const exec =
 * promisify(execFile)` pair had four byte-identical copies (rule-pack,
 * lizard, ast-grep, agent-setup/templates) — flagged by loctx's own
 * semantic duplicate detection at similarity 1.0.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);
