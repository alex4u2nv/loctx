# Generation-provider spike: local LLM quality hints (#528)

**Verdict: no-go.** Park the `GenerationProvider` design. Do not build
Tier 3 on sub-1B local models. Revisit only if a materially better
small code model ships in ONNX form, and re-run this exact benchmark
first.

## Question

Can a small local code-instruct model produce quality hints worth
their inference cost, inside loctx's local-first constraints
(no new native dependencies, downloads gated by `requireOutboundAllowed`
and `trusted-models.ts`)?

## Method

One rule, "mixed concerns" classification, run over 50 TypeScript
files (1 to 20 KB) from `packages/core/src`. Runtime:
`@huggingface/transformers` 3.8.1 `text-generation` pipeline, the same
ONNX runtime loctx already ships for embeddings. Model:
`onnx-community/Qwen2.5-Coder-0.5B-Instruct`, q4, greedy decoding,
60 output tokens, file content truncated at 6 KB. The prompt demanded
compact JSON: `{"mixed_concerns": bool, "reason": string}`.

Benchmark script and raw output live with the spike session; the
numbers below are from the full 50-file run on Apple Silicon.

## Results

| Metric | Value | Gate (from #528) | Pass |
| --- | --- | --- | --- |
| p50 latency / file | 3.8 s | p95 < 10 s | no |
| p95 latency / file | 200.7 s | p95 < 10 s | no, by 20x |
| mean latency / file | 29.5 s | | |
| Peak RSS | 6.6 GB | reasonable on a laptop | no |
| Model load | 30.7 s | | |
| Precision | degenerate | > 0.7 | no |

The precision result needs no hand-labeling: the model classified
**50 of 50 files** as `mixed_concerns: true`, including pure-logic
modules with no I/O at all (`_validate.ts` is spec-table validators
top to bottom). Every "reason" was the system prompt's own definition
echoed back. The classifier has zero discriminative value; precision
equals the base rate by construction.

## Why we did not run the 1.5B model

The issue's protocol called for 0.5B and 1.5B. The 0.5B run failed
the latency gate by 20x and the memory budget by several GB. A 3x
larger model strictly worsens both failed gates; the only gate it
could improve is precision, and no precision rescues a p95 that would
pin a laptop for minutes per file. Running it would cost a multi-GB
download to confirm a foregone conclusion.

## What survives the spike

- The **integration path is proven**: `@huggingface/transformers`
  runs `text-generation` in-process with no new native dependency.
  The `GenerationProvider` interface sketch in #528 stays valid if a
  usable model appears.
- The **queue changes** the design flagged (per-analyzer concurrency
  and timeout overrides) remain prerequisites for any future attempt;
  the 60 s default timeout would kill most of these runs.
- The heuristic and embedding tiers (#522, #523, #524, #527, #525)
  already deliver the classification-style signals this tier promised,
  deterministically and in milliseconds. The bar a local LLM must
  clear is now higher than when the epic was written.

## Decision

Recorded on #521 and #528: **park**. No `GenerationProvider`
implementation, no generation-model registry, no Models-tab changes.
The M9 milestone closes with the deterministic tiers.
