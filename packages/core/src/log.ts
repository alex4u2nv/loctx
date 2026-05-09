/**
 * Privacy-aware logging helper.
 *
 * loctx's default log output should be safe to share in a bug report —
 * file content stays out, and absolute paths are reduced to project-
 * relative when a project root is in scope. Verbose mode (opt-in via
 * `LOCTX_LOG=debug`) prints the full picture for local debugging.
 *
 * The helper is opt-in. New callsites that handle paths or chunk content
 * use it; existing `console.error` / `console.log` calls stay until a
 * sweep migrates them. Deliberate to avoid risking regressions in tests
 * that grep stderr for known strings.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogOptions {
  /** Project root used to convert abs paths to relative when present. */
  readonly projectRoot?: string;
  /** Skip path scrubbing (callsite verified the value is safe). */
  readonly raw?: boolean;
}

export function isVerbose(): boolean {
  return process.env["LOCTX_LOG"] === "debug";
}

/**
 * Print to stderr with optional path scrubbing. Chunk content (anything
 * larger than 1 KB or containing a newline) is summarized to its length
 * and a short prefix; verbose mode keeps the original.
 */
export function safeLog(level: LogLevel, message: string, options: LogOptions = {}): void {
  if (level === "debug" && !isVerbose()) return;
  const out = options.raw === true || isVerbose() ? message : scrub(message, options);
  const prefix = level === "info" ? "" : `[${level}] `;
  console.error(`${prefix}${out}`);
}

const ABS_PATH_RE = /(^|\s)(\/[^\s]+)/g;
const LARGE_CHUNK_THRESHOLD = 1000;

/**
 * Reduce a message for safe-by-default logging:
 *   - Absolute paths inside `projectRoot` become `<root>/<rel>` form.
 *   - Absolute paths outside the project become `~/.../<basename>`.
 *   - Strings longer than 1 KB or containing a newline get summarized.
 */
function scrub(message: string, options: LogOptions): string {
  if (message.length > LARGE_CHUNK_THRESHOLD || message.includes("\n")) {
    return `<${message.length}-byte message; LOCTX_LOG=debug for full content>`;
  }
  if (options.projectRoot === undefined) return message;
  const root = options.projectRoot;
  return message.replace(ABS_PATH_RE, (_match, leading: string, abs: string) => {
    if (abs.startsWith(`${root}/`)) {
      return `${leading}<project>/${abs.slice(root.length + 1)}`;
    }
    return `${leading}<external>/${basenameOnly(abs)}`;
  });
}

function basenameOnly(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}
