/**
 * `quality` — project quality report + accepted-debt baseline (#566).
 *
 * `report` prints the severity-ranked file list the MCP tool and the
 * web UI show, honoring `.loctx-quality.yaml` suppressions and the
 * baseline. `baseline` snapshots the currently visible findings into
 * `.loctx-quality-baseline.json` at the project root (commit it), so
 * later reports surface only NEW findings — the ratchet that makes
 * adoption on a brownfield codebase tractable.
 *
 * Both verbs read stored state + vectors and never embed, so a local
 * one-shot runtime is fast; no daemon round-trip needed.
 */

import {
  BASELINE_FILE,
  buildRuntime,
  type Runtime,
  runQualityBaseline,
  runQualityReport,
  scoreProjectHealth,
} from "@loctx/core";
import type { Command } from "commander";
import {
  getCtx,
  loadConfigOrFail,
  noProjectMarkerError,
  resolveCommandPath,
} from "../lib/context.js";

interface QualityReportOptions {
  readonly rule?: string;
  readonly limit: number;
  readonly includeSuppressed: boolean;
}

async function withRuntime(run: (runtime: Runtime) => Promise<void>): Promise<void> {
  const config = loadConfigOrFail(getCtx());
  const runtime = await buildRuntime(config);
  try {
    await run(runtime);
  } finally {
    await runtime.close();
  }
}

export function registerQualityCommands(program: Command): void {
  const quality = program
    .command("quality")
    .description(
      "Project quality report, code-health score, and accepted-debt baseline. Requires a subcommand: report, health, baseline.",
    );

  quality
    .command("health [path]")
    .description(
      "Code Health score (0–100, graded A–F) for the project at PATH (or containing cwd): " +
        "the quality report rolled up by dimension — complexity, coupling, duplication, " +
        "cohesion, documentation — weighted and normalised by file count. Suppressions and " +
        "the baseline apply. Persists a snapshot when the score changed.",
    )
    .option("--json", "Print the full CodeHealth JSON.", false)
    .action(async (path: string | undefined, opts: { json: boolean }) => {
      const project = resolveCommandPath(path);
      if (project === null) noProjectMarkerError("quality health", path);
      await withRuntime(async (runtime) => {
        const scored = await scoreProjectHealth(runtime, project);
        if (scored === null) {
          console.log(`${project.name}: not scored — no indexed files. Run \`loctx index\` first.`);
          return;
        }
        const { health, changed } = scored;
        if (opts.json) {
          console.log(JSON.stringify(health, null, 2));
          return;
        }
        console.log(
          `${project.name}: ${health.grade} ${health.score}/100${changed ? "" : " (unchanged)"}`,
        );
        for (const d of health.dimensions) {
          const coverage = d.coverage === "full" ? "" : `  [${d.coverage} coverage]`;
          console.log(
            `  ${d.label.padEnd(14)} ${String(d.score).padStart(3)}  ${d.findings} finding(s)${coverage}`,
          );
        }
        const history = runtime.state.listProjectHealth(project.id, 5);
        if (history.length > 1) {
          console.log(
            `# history: ${history.map((h) => `${h.grade} ${h.score} @ ${h.computedAt.slice(0, 10)}`).join(" ← ")}`,
          );
        }
        for (const note of health.notes) console.log(`# note: ${note}`);
      });
    });

  quality
    .command("report [path]")
    .description(
      "Severity-ranked quality findings for the project at PATH (or containing cwd). " +
        "Suppressions from .loctx-quality.yaml and the committed baseline apply; " +
        "the suppressed count is always shown.",
    )
    .option("--rule <id>", "Only findings with this exact ruleId (e.g. quality/god-file).")
    .option("--limit <n>", "Max files in the report.", (v) => Number.parseInt(v, 10), 20)
    .option("--include-suppressed", "Show findings hidden by suppressions or the baseline.", false)
    .action(async (path: string | undefined, opts: QualityReportOptions) => {
      const project = resolveCommandPath(path);
      if (project === null) noProjectMarkerError("quality report", path);
      await withRuntime(async (runtime) => {
        const report = await runQualityReport(runtime, project, {
          limit: opts.limit,
          ...(opts.rule !== undefined ? { rule: opts.rule } : {}),
          ...(opts.includeSuppressed ? { includeSuppressed: true } : {}),
        });
        if (report.files.length === 0) console.log("No findings.");
        for (const file of report.files) {
          console.log(`${file.relPath}  (weight ${file.weight})`);
          for (const f of file.findings) {
            console.log(`  [${f.severity}] ${f.ruleId} ${f.lineFrom}-${f.lineTo}: ${f.message}`);
          }
        }
        const t = report.totals;
        console.log(
          `# ${t.findings} finding(s) in ${t.files} file(s) — ` +
            `${t.errors} error, ${t.warnings} warning, ${t.infos} info` +
            (t.suppressed > 0 ? `, ${t.suppressed} suppressed` : ""),
        );
        for (const note of report.notes) console.log(`# note: ${note}`);
      });
    });

  quality
    .command("baseline [path]")
    .description(
      `Snapshot the currently visible findings into ${BASELINE_FILE} at the project ` +
        "root (accepted debt — commit it). Reports then show only NEW findings; " +
        "re-run after paying debt down so the ratchet tightens.",
    )
    .action(async (path: string | undefined) => {
      const project = resolveCommandPath(path);
      if (project === null) noProjectMarkerError("quality baseline", path);
      await withRuntime(async (runtime) => {
        const result = await runQualityBaseline(runtime, project);
        console.log(
          `Baseline written: ${result.path} (${result.entries} entries across ${result.files} files).`,
        );
        console.log("Commit it — quality reports now show only findings not in the baseline.");
      });
    });
}
