/**
 * Interactive first-run wizard for `loctx init`.
 *
 * Walks a new user through a short series of questions and writes a
 * sensible global config without making them learn the YAML schema
 * up front. Pairs with the `loctx model` registry from #79 — model
 * recommendations come straight from there.
 *
 * Non-TTY environments (CI, scripts) get a clear refusal; nothing
 * silently picks defaults that would surprise the user later.
 */

import { existsSync, writeFileSync } from "node:fs";
import { confirm, input, select } from "@inquirer/prompts";
import { EMBEDDING_REGISTRY, type EmbeddingModelInfo, type EmbeddingUseCase } from "@loctx/core";
import { stringify as stringifyYaml } from "yaml";

export interface WizardOptions {
  /** Where to write the resulting YAML (typically the global config path). */
  readonly target: string;
  /** Allow overwriting an existing file. */
  readonly force: boolean;
}

interface WizardAnswers {
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly useCase: EmbeddingUseCase;
  readonly model: EmbeddingModelInfo;
  readonly downloadModel: boolean;
  readonly daemonPort: number;
}

/**
 * Run the wizard and write the chosen config to `options.target`.
 * Returns the path that was written. Throws if the user declines.
 */
export async function runInitWizard(options: WizardOptions): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "loctx init requires an interactive TTY. Use 'loctx config init' for the non-interactive template.",
    );
  }
  if (existsSync(options.target) && !options.force) {
    throw new Error(`${options.target} already exists. Re-run with --force to overwrite.`);
  }

  console.error("loctx setup — three quick questions, then I'll write the config.\n");

  const workspaceRoots = await collectWorkspaceRoots();
  const useCase = await pickUseCase();
  const model = await pickModel(useCase);
  const downloadModel = await confirm({
    message: `Download ${model.name} now (~${model.sizeMB} MB)? Skips the first-run stall on \`loctx start\`.`,
    default: true,
  });
  const daemonPort = await pickDaemonPort();

  const yaml = buildYaml({
    workspaceRoots,
    useCase,
    model,
    downloadModel,
    daemonPort,
  });

  writeFileSync(options.target, yaml, "utf-8");
  console.error(`\n[loctx init] wrote ${options.target}`);
  if (downloadModel) {
    console.error("[loctx init] downloading the embedding model...");
    const { LocalEmbeddingProvider, defaultPaths, markModelTrusted, setAllowedOutboundReasons } =
      await import("@loctx/core");
    // The wizard is interactive opt-in; if the user said yes to download,
    // explicitly allow the outbound call. Other commands keep the
    // local-first default (blocked).
    setAllowedOutboundReasons(["model-download"]);
    const dataDir = defaultPaths().dataDir;
    const provider = new LocalEmbeddingProvider({
      modelName: model.name,
      normalize: model.normalize,
      dataDir,
    });
    await provider.ensureReady();
    // Persist the consent so subsequent commands skip the gate for this
    // model.
    markModelTrusted(dataDir, model.name);
    console.error("[loctx init] download complete.");
  }
  console.error("[loctx init] run 'loctx start' to begin indexing.");
  return options.target;
}

// ---- prompts ----------------------------------------------------------

const COMMON_ROOTS = ["~/Workspaces", "~/Documents", "~/.claude/skills", "~/Projects"];

async function collectWorkspaceRoots(): Promise<ReadonlyArray<string>> {
  console.error("Which directories should loctx index?");
  console.error("Pick a starting suggestion or enter a custom path; you can add more later.\n");

  const choice = await select({
    message: "Workspace root (1 of N):",
    choices: [
      ...COMMON_ROOTS.map((p) => ({ name: p, value: p })),
      { name: "Custom path…", value: "<custom>" },
    ],
  });

  const first = choice === "<custom>" ? await input({ message: "Path:" }) : choice;
  const roots: string[] = [first];

  while (
    await confirm({
      message: "Add another workspace root?",
      default: false,
    })
  ) {
    const next = await input({ message: "Path:" });
    if (next.trim() !== "") roots.push(next);
  }
  return roots;
}

async function pickUseCase(): Promise<EmbeddingUseCase> {
  const value = await select<EmbeddingUseCase>({
    message: "What's your primary use case?",
    choices: [
      {
        name: "Mixed — code + docs + skills + notes (recommended for agents)",
        value: "mixed" as const,
      },
      { name: "Code — pure source-code search", value: "code" as const },
      { name: "Docs — knowledge base / process library only", value: "docs" as const },
    ],
  });
  return value;
}

async function pickModel(useCase: EmbeddingUseCase): Promise<EmbeddingModelInfo> {
  const matching = EMBEDDING_REGISTRY.filter((m) => m.useCase === useCase);
  const fallback = EMBEDDING_REGISTRY.filter((m) => m.useCase === "mixed");
  const ordered = [...matching, ...fallback.filter((m) => !matching.includes(m))];

  const recommended = ordered[0];
  if (recommended === undefined) {
    throw new Error("registry is empty — this should never happen");
  }
  const name = await select({
    message: "Embedding model:",
    default: recommended.name,
    choices: ordered.map((m) => ({
      name: `${m.name}  (${m.sizeMB} MB · ${m.dimension}-dim)\n      ${m.description}`,
      value: m.name,
    })),
  });
  const picked = ordered.find((m) => m.name === name);
  if (picked === undefined) throw new Error(`model not in catalog: ${name}`);
  return picked;
}

async function pickDaemonPort(): Promise<number> {
  const raw = await input({
    message: "Daemon port for the admin UI + /mcp endpoint:",
    default: "3022",
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n > 0 && n < 65536 ? true : "Enter a port in 1..65535.";
    },
  });
  return Number.parseInt(raw, 10);
}

// ---- yaml writer ------------------------------------------------------

function buildYaml(answers: WizardAnswers): string {
  const doc: Record<string, unknown> = {
    workspace_roots: [...answers.workspaceRoots],
    embedding: {
      provider: "huggingface-transformers",
      model: answers.model.name,
      normalize: answers.model.normalize,
    },
    daemon: {
      port: answers.daemonPort,
      hostname: "localhost",
    },
    retrieval: {
      mode: "hybrid",
      rrf_k: 60,
    },
    watcher: {
      debounce_ms: 500,
    },
  };
  const banner = `# loctx config — generated by 'loctx init'.\n# Use case: ${answers.useCase}.\n# Edit freely; 'loctx config show' explains every key + source.\n\n`;
  return banner + stringifyYaml(doc);
}
