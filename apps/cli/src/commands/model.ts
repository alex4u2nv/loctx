/**
 * `model` (list / current / use / download) — embedding-model management.
 */

import { readActiveDaemon } from "@loctx/core";
import type { Command } from "commander";
import { confirm, EXIT, getCtx, loadConfigOrFail } from "../lib/context.js";

/**
 * Persist the model switch through core's comment-preserving writer:
 * it validates the patch, round-trips the YAML Document (user comments,
 * blank lines, and key order survive), and stages through a tmp+rename
 * so a crash can't half-write the file. Returns false (after printing
 * the validation errors) when nothing was written.
 */
async function writeModelChoice(modelName: string, normalize: boolean): Promise<boolean> {
  const { writeConfigPatch } = await import("@loctx/core");
  const result = writeConfigPatch(getCtx().configPath, {
    "embedding.model": modelName,
    "embedding.normalize": normalize,
  });
  if (!result.ok) {
    const detail = result.errors.map((e) => `${e.key}: ${e.message}`).join("; ");
    console.error(`[loctx model] failed to update config: ${detail}`);
    return false;
  }
  return true;
}

export function registerModelCommands(program: Command): void {
  const modelCmd = program
    .command("model")
    .description("Manage the embedding model used for indexing. Requires a subcommand.");

  modelCmd
    .command("list")
    .description("Show available embedding models with size, dimension, and use case.")
    .action(async () => {
      const { EMBEDDING_REGISTRY } = await import("@loctx/core");
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);
      const current = config.embedding.model;
      console.log("Available embedding models:");
      for (const m of EMBEDDING_REGISTRY) {
        const marker = m.name === current ? "*" : " ";
        console.log(
          `  ${marker} ${m.name.padEnd(46)} ${String(m.sizeMB).padStart(4)} MB  dim=${String(m.dimension).padStart(4)}  [${m.useCase}]  ${m.license}`,
        );
        console.log(`      ${m.description}`);
      }
      console.log("");
      console.log("* = active. Run 'loctx model use <name>' to switch.");
      console.log(
        "Models download from Hugging Face on first use — you accept the listed license.",
      );
    });

  modelCmd
    .command("current")
    .description("Print the active embedding model.")
    .action(() => {
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);
      console.log(config.embedding.model);
    });

  modelCmd
    .command("use <name>")
    .description(
      "Switch the active embedding model. Reindex required afterward. " +
        "Prompts for confirmation unless --yes — switching invalidates the existing " +
        "index and forces a full re-embed pass on every project.",
    )
    .option("-y, --yes", "Skip the confirmation prompt.", false)
    .action(async (name: string, opts: { yes: boolean }) => {
      const { findModel } = await import("@loctx/core");
      const info = findModel(name);
      if (info === null) {
        console.error(`Unknown model '${name}'. Run 'loctx model list' to see available options.`);
        process.exit(EXIT.error);
      }
      // Mirror the /models web confirm (#315). A model switch silently
      // invalidates the existing index: LanceDB throws
      // CollectionIdentityMismatch on next daemon start, and the user
      // is forced into `loctx reset index --force` + hours of re-embed.
      if (!opts.yes) {
        const ok = await confirm(
          `Switch embedding.model to ${info.name}? Existing index will mismatch on next daemon start (CollectionIdentityMismatch) — recovery is \`loctx reset index --force\` + re-index every project, which can take minutes to hours.`,
        );
        if (!ok) {
          console.error("[loctx model use] cancelled.");
          process.exit(EXIT.error);
        }
      }
      if (!(await writeModelChoice(info.name, info.normalize))) {
        process.exitCode = EXIT.error;
        return;
      }
      console.error(`[loctx model use] switched embedding.model to ${info.name}.`);
      console.error("[loctx model use] the existing index was built for the previous model;");
      console.error("                  run 'loctx reset index' then 'loctx index' to rebuild it,");
      console.error("                  or expect a CollectionIdentityMismatch on next start.");
      // A running daemon keeps the old model in memory until it restarts.
      // Without this warning, the user assumes the swap took effect, hits
      // the daemon, and gets stale-model results until they happen to
      // restart. Mirrors the /admin disable-reset-while-running posture.
      if (readActiveDaemon(loadConfigOrFail(getCtx()).paths.dataDir) !== null) {
        console.error(
          "[loctx model use] note: a daemon is running and still holds the old model. " +
            "Run 'loctx restart' after the reset+reindex to apply.",
        );
      }
    });

  modelCmd
    .command("download <name>")
    .description("Pre-download a model into the Hugging Face cache. Useful offline prep.")
    .option(
      "--use",
      "Also set this model as the active one in embedding.model (global config).",
      false,
    )
    .action(async (name: string, opts: { use: boolean }) => {
      const { findModel, LocalEmbeddingProvider, markModelTrusted, setAllowedOutboundReasons } =
        await import("@loctx/core");
      const info = findModel(name);
      if (info === null) {
        console.error(`Unknown model '${name}'. Run 'loctx model list' to see options.`);
        process.exit(EXIT.error);
      }
      const ctx = getCtx();
      const config = loadConfigOrFail(ctx);
      // Explicit user opt-in for an outbound fetch. Other commands keep
      // the default (blocked) behaviour from #43.
      setAllowedOutboundReasons(["model-download"]);
      console.error(`[loctx model download] fetching ${info.name} (~${info.sizeMB} MB)...`);
      const provider = new LocalEmbeddingProvider({
        modelName: info.name,
        normalize: info.normalize,
        dataDir: config.paths.dataDir,
      });
      await provider.ensureReady();
      // Persist the consent so subsequent commands (daemon, index, search)
      // can load this model without flipping the in-process allow flag.
      markModelTrusted(config.paths.dataDir, info.name);
      console.error("[loctx model download] done.");
      if (opts.use) {
        const previous = config.embedding.model;
        if (!(await writeModelChoice(info.name, info.normalize))) {
          process.exitCode = EXIT.error;
          return;
        }
        console.error(`[loctx model download] embedding.model: ${previous} → ${info.name}`);
        console.error(
          "[loctx model download] the existing index was built for the previous model;",
        );
        console.error(
          "                       run 'loctx reset index --force' then 'loctx index' to rebuild it.",
        );
      } else if (info.name !== config.embedding.model) {
        console.error(
          `[loctx model download] note: active model is still ${config.embedding.model}. ` +
            `Run 'loctx model use ${info.name}' (or rerun with --use) to switch.`,
        );
      }
    });

  modelCmd.action(() => {
    console.log("loctx model: specify a subcommand (list, current, use, download).");
    console.log("Use --help for options.");
  });
}
