/**
 * Lizard complexity analyzer (#62).
 *
 * Lizard (https://github.com/terryyin/lizard) reports cyclomatic
 * complexity, NLOC, token count, and parameter count per function in
 * many languages. We invoke it as an external process; it is opt-in
 * via `analyzers.lizard.enabled` and disabled by default. Missing
 * binary is a soft failure.
 *
 * Output parsing
 * --------------
 * Lizard's CSV output (`lizard --csv <file>`) emits one row per
 * function:
 *
 *   NLOC,CCN,token,PARAM,length,location,filename,function_name,...
 *
 * We keep the columns we use and ignore the rest. Lizard versions
 * older than 1.17 omit some columns; the parser tolerates short rows.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const LIZARD_VERSION = 1;

export interface LizardFunctionMetric {
  readonly name: string;
  readonly nloc: number;
  readonly ccn: number;
  readonly tokens: number;
  readonly parameters: number;
  readonly lineFrom: number;
  readonly lineTo: number;
}

export interface LizardFileResult {
  readonly file: string;
  readonly functions: ReadonlyArray<LizardFunctionMetric>;
}

const exec = promisify(execFile);

/**
 * Resolve the lizard command. Defaults to `lizard` on PATH; users
 * override via `analyzers.lizard.command` for venv installs or full
 * paths. Returns null when the binary is not reachable.
 */
export async function detectLizard(command = "lizard"): Promise<string | null> {
  try {
    await exec(command, ["--version"], { timeout: 2000 });
    return command;
  } catch {
    return null;
  }
}

/**
 * Run lizard against a single file, parse the CSV output, return
 * per-function metrics. Throws on non-zero exit; the caller
 * (`EnrichmentQueue` runner) translates that to a `failed` status.
 */
export async function runLizard(
  command: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<LizardFileResult> {
  // The `signal` is wired through to Node's child_process so an aborted
  // task SIGTERMs the lizard child instead of letting it churn until
  // the internal 30s timeout (#197).
  const { stdout } = await exec(command, ["--csv", filePath], {
    timeout: 30_000,
    ...(signal !== undefined ? { signal } : {}),
  });
  return parseLizardCsv(filePath, stdout);
}

/**
 * Parse lizard's CSV output. Each row's columns:
 *   NLOC, CCN, token, PARAM, length, location, file, function, …
 * `location` is `"file_path:line_from-line_to"`. We split on `:` and
 * `-` to extract line ranges. Empty lines and the header row (when
 * present) are dropped.
 */
export function parseLizardCsv(file: string, csv: string): LizardFileResult {
  const functions: LizardFunctionMetric[] = [];
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const cols = line.split(",");
    if (cols.length < 8) continue;
    const nloc = Number(cols[0]);
    const ccn = Number(cols[1]);
    const tokens = Number(cols[2]);
    const parameters = Number(cols[3]);
    if (!Number.isFinite(nloc) || !Number.isFinite(ccn)) continue;
    const location = cols[5] ?? "";
    const name = (cols[7] ?? "").trim();
    const range = parseLocation(location);
    if (range === null) continue;
    functions.push({
      name,
      nloc,
      ccn,
      tokens,
      parameters,
      lineFrom: range.lineFrom,
      lineTo: range.lineTo,
    });
  }
  return Object.freeze({ file, functions: Object.freeze(functions) });
}

function parseLocation(loc: string): { lineFrom: number; lineTo: number } | null {
  // Lizard's CSV mode emits the function range as the 6th column in
  // the form "<file>:<from>-<to>"; older versions drop the file
  // prefix. Pull the last colon-separated chunk and split on `-`.
  const after = loc.includes(":") ? loc.slice(loc.lastIndexOf(":") + 1) : loc;
  const [from, to] = after.split("-");
  const lineFrom = Number(from);
  const lineTo = Number(to);
  if (!Number.isFinite(lineFrom) || !Number.isFinite(lineTo)) return null;
  return { lineFrom, lineTo };
}
