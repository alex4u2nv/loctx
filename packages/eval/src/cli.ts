#!/usr/bin/env node
/**
 * `loctx-eval` CLI entrypoint. Thin shell over the command modules in
 * `cmd/`; all real work lives there so the same surface is callable
 * programmatically from a test or a future driver.
 */

import { Command } from "commander";
import { compareCommand } from "./cmd/compare.js";
import { indexCommand } from "./cmd/index.js";
import { reportCommand } from "./cmd/report.js";
import { runCommand } from "./cmd/run.js";
import { validateCommand } from "./cmd/validate.js";
import { errorMessage } from "./errors.js";

const program = new Command()
  .name("loctx-eval")
  .description("Offline retrieval-quality eval harness for loctx.")
  .version("0.0.1");

program
  .command("index <golden-set>")
  .description("Snapshot the pinned corpus and index it. Prints the chunk-boundary digest.")
  .action(async (goldenSet: string) => {
    const result = await indexCommand({ goldenSet });
    console.log(`indexed files:        ${result.indexedFiles}`);
    console.log(`chunks:               ${result.chunkCount}`);
    console.log(`chunk_boundary_hash:  ${result.chunkBoundaryHash}`);
  });

program
  .command("run <golden-set>")
  .description("Index the pinned corpus, run every query, write TREC + JSON run files.")
  .option("--runs-dir <dir>", "Directory to write TREC + JSON run files into.")
  .action(async (goldenSet: string, opts: { runsDir?: string }) => {
    const result = await runCommand({
      goldenSet,
      ...(opts.runsDir !== undefined ? { runsRoot: opts.runsDir } : {}),
    });
    console.log(`run_id:    ${result.runId}`);
    console.log(`trec:      ${result.trecPath}`);
    console.log(`json:      ${result.jsonPath}`);
  });

program
  .command("report <target>")
  .description("Render a Markdown report for a run JSON (or the latest *.json in a directory).")
  .action((target: string) => {
    const result = reportCommand({ target });
    console.log(result.markdown);
    console.error(`# wrote ${result.markdownPath}`);
  });

program
  .command("compare <run-a> <run-b>")
  .description("Pairwise delta table over two run JSONs.")
  .action((a: string, b: string) => {
    console.log(compareCommand({ a, b }));
  });

program
  .command("validate <golden-set>")
  .description(
    "Cross-check every qrel span against the indexed corpus's chunk boundaries. Non-zero exit on any qrel whose file or span is gone (gold-set rot).",
  )
  .action(async (goldenSet: string) => {
    const result = await validateCommand({ goldenSet });
    const c = result.counts;
    console.log(
      `validated ${result.total} qrels — exact=${c.exact} drift=${c.drift} ` +
        `no-overlap=${c["no-overlap"]} missing-file=${c["missing-file"]}`,
    );
    for (const f of result.failures) {
      console.error(`  ✗ ${f.queryId} ${f.relPath}:${f.startLine}-${f.endLine} (${f.status})`);
    }
    if (!result.ok) {
      console.error(
        `\n${result.failures.length} qrel(s) no longer resolvable in the corpus — ` +
          "the gold set has drifted. Fix the spans or bump to a new gold-set version.",
      );
      process.exit(1);
    }
    console.log("gold set is intact.");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = errorMessage(err);
  console.error(`[loctx-eval] ${message}`);
  if (process.env["LOCTX_LOG"] === "debug" && err instanceof Error) {
    console.error(err.stack ?? message);
  }
  process.exit(1);
});
