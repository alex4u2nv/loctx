---
name: typescript
description: Apply architectural patterns when writing or editing TypeScript / Node.js. Validator + Spec strategy for runtime validation (or zod at scale), external SQL/YAML resources, layered configuration, Record-keyed dispatch, _write/_read DB helpers, never-returning terminal CLI commands, readonly value types, branded IDs, discriminated unions, lazy dynamic imports, ESM-first, strict tsconfig with noUncheckedIndexedAccess, plus latest language features and core SE principles (abstraction, encapsulation, DRY, SoC, composition over inheritance, generics). Auto-loads on TypeScript/Node edits. Pairs with the code-style skill (which covers idioms and modern syntax).
---

# TypeScript patterns

Architectural defaults for non-trivial TypeScript work in Node. Pair with the
`code-style` skill (modern syntax, functional idioms). Apply the rules below
when adding meaningful code; skip them for one-off scripts.

## Strict tsconfig is the contract

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

- Never `any`. Use `unknown` and narrow at the boundary.
- `// @ts-ignore` only as a last resort; prefer `// @ts-expect-error: <reason>`
  so it errors when no longer needed. Drop it the moment it stops being
  needed.
- ESM-first: `"type": "module"` in `package.json`, `import` statements with
  `.js` extensions on relative paths, `node:` prefix for built-ins
  (`node:fs`, `node:path`, `node:url`).

## Validate untrusted data through Validator + Spec — or use zod

For runtime validation of user-supplied data (JSON, YAML, env, request bodies),
two equally valid approaches:

### Pattern A — hand-rolled Validator + Spec (no deps)

Mirrors `dict.get` semantics. New accepted types add a single Spec constant.

```typescript
export interface Spec<T> {
  readonly typeCheck: (value: unknown) => boolean;
  readonly expected: string;                   // error label: "must be {expected}"
  readonly convert?: (value: unknown) => T;    // e.g. to defensively copy
}

export const INT: Spec<number> = {
  typeCheck: (v) => typeof v === "number" && Number.isInteger(v),
  expected: "an integer",
};
export const INT_NON_NEG: Spec<number> = {
  typeCheck: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
  expected: "a non-negative integer",
};
export const STR: Spec<string> = {
  typeCheck: (v) => typeof v === "string",
  expected: "a string",
};
export const BOOL: Spec<boolean> = {
  typeCheck: (v) => typeof v === "boolean",
  expected: "a boolean",
};
export const STR_ARRAY: Spec<readonly string[]> = {
  typeCheck: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  expected: "an array of strings",
  convert: (v) => Object.freeze([...(v as string[])]),  // defensive copy
};

export class Validator {
  constructor(
    private readonly errorCtor: new (msg: string) => Error,
    private readonly source: string = "",
  ) {}

  // dict.get-style overloads
  get<T>(data: Record<string, unknown>, key: string, spec: Spec<T>): T | undefined;
  get<T>(data: Record<string, unknown>, key: string, spec: Spec<T>, defaultValue: T): T;
  get<T>(
    data: Record<string, unknown>,
    key: string,
    spec: Spec<T>,
    defaultValue?: T,
  ): T | undefined {
    if (!(key in data)) return defaultValue;
    const value = data[key];
    if (!spec.typeCheck(value)) {
      throw this.makeError(`${key} must be ${spec.expected}`);
    }
    return spec.convert ? spec.convert(value) : (value as T);
  }

  // typed shortcuts — each is a one-line delegate
  getInt(data: Record<string, unknown>, key: string, opts?: { nonNegative?: boolean }): number | undefined {
    return this.get(data, key, opts?.nonNegative ? INT_NON_NEG : INT);
  }
  getBool(data: Record<string, unknown>, key: string): boolean | undefined {
    return this.get(data, key, BOOL);
  }
  getStr(data: Record<string, unknown>, key: string): string | undefined {
    return this.get(data, key, STR);
  }
  getStrArray(data: Record<string, unknown>, key: string): readonly string[] | undefined {
    return this.get(data, key, STR_ARRAY);
  }

  requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw this.makeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
  }

  private makeError(msg: string): Error {
    return new this.errorCtor(this.source ? `${this.source}: ${msg}` : msg);
  }
}
```

Call sites:

```typescript
const v = new Validator(MyDomainError, sourcePath);
const size     = v.getInt(data, "maxBytes", { nonNegative: true });   // number | undefined
const enabled  = v.getBool(data, "enabled");                           // boolean | undefined
const provider = v.get(data, "provider", STR, "anonymous");            // string
const debounce = v.get(data, "debounceMs", INT, 500);                  // number
```

### Pattern B — zod for schema-shaped configs

For larger configs or external API payloads, prefer **zod** (or valibot /
arktype). It's the canonical Validator + Spec at scale, with type inference
out of the box.

```typescript
import { z } from "zod";

const ConfigSchema = z.object({
  workspaceRoots: z.array(z.string()).default(["~/projects"]),
  embedding: z.object({
    provider: z.string().default("sentence-transformers"),
    model: z.string().default("all-MiniLM-L6-v2"),
    normalize: z.boolean().default(true),
  }),
  watcher: z.object({
    debounceMs: z.number().int().nonnegative().default(500),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(z.prettifyError(result.error));
  return result.data;
}
```

Pick A for ~10 fields and zero deps. Pick B for deeply nested configs,
discriminated unions, or anything user-facing where great error messages
matter.

## External resources over inline strings

- **SQL** belongs in `.sql` files loaded at module init. Use named-section
  markers (`-- :name <ident>`) and a tiny parser returning
  `Record<string, string>`. Reference queries by name in code.
- **Schemas / config defaults** belong in `.yaml` / `.json` files alongside
  source. Load with `readFileSync(new URL("./data.yaml", import.meta.url))`.
- Heredoc-style multi-line template literals for SQL/HTML/JSON strewn across
  modules are an anti-pattern — they hide content from syntax highlighting,
  formatters, and grep.

```typescript
// Resolve a sibling resource via import.meta.url (ESM-friendly).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sqlText = readFileSync(
  fileURLToPath(new URL("./state.sql", import.meta.url)),
  "utf-8",
);
```

## Layered configuration

When a config has bundled defaults plus user overrides:

1. Read package defaults first.
2. Read user overrides from a directory (`*.yaml`, `*.yml`, `*.json`),
   sorted alphabetically so users can prefix `10-`, `20-` to control order.
3. **List keys**: extend (dedupe via `Set`, preserve insertion order with
   `[...new Set([...base, ...extra])]`).
4. **Scalar keys**: replace.
5. **Subtractive removal**: explicit `removeIgnoredDirs: [...]` instead of
   silently shrinking lists — a typo never silently drops a baseline entry.
6. **Unknown keys**: throw. Don't silently ignore — a typo is almost always
   a misconfiguration.

## Record-keyed dispatch over object-property bag

If you find yourself writing `obj[key as keyof typeof obj]` in a loop over a
tuple of field names, refactor: move those fields into a single
`Record<string, T>` field. The loop body collapses, `noUncheckedIndexedAccess`
keeps it safe.

```typescript
// Before
const fields = ["ignoredDirs", "secretGlobs", "allowedExts"] as const;
for (const f of fields) {
  acc[f] = extendUnique(acc[f], extras[f]);  // requires casts
}

// After
type ListKey = "ignoredDirs" | "secretGlobs" | "allowedExts";

interface Accumulator {
  scalars: { maxBytes: number; followSymlinks: boolean };
  lists: Record<ListKey, string[]>;
}

for (const key of ["ignoredDirs", "secretGlobs", "allowedExts"] as const) {
  acc.lists[key] = extendUnique(acc.lists[key], extras[key] ?? []);
}
```

## Pure helpers (rule of three)

Extract small named helpers when an idiom recurs and a name clarifies it.
Default to the **rule of three**: two copies is a watch signal, the *third*
use is the trigger — premature abstraction is worse than a little
duplication, and a helper carrying 3+ params to satisfy a hypothetical
caller is a net loss. Exceptions: a short *byte-identical* block (e.g. a
30-line test fixture) is worth sharing at two; a superficially-similar
2-3 line idiom usually isn't. When a project sets its own threshold (e.g.
loctx's "extract before the third caller"), that wins.

```typescript
export function extendUnique<T>(items: Iterable<T>, extras: Iterable<T>): T[] {
  return [...new Set([...items, ...extras])];
}

export function subtract<T>(items: Iterable<T>, removals: Iterable<T>): T[] {
  const drop = new Set(removals);
  return [...items].filter((item) => !drop.has(item));
}
```

## Database access: `_write` / `_readOne` / `_readAll` helpers

For any class that wraps a SQLite (better-sqlite3) or Postgres connection,
centralize prepare-and-run / parameter binding in three helpers. Public
methods become one-liners that reference SQL by name.

```typescript
import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

export class StateStore {
  private readonly stmts = new Map<string, Statement>();

  constructor(
    private readonly db: Database.Database,
    private readonly queries: Record<string, string>,
  ) {}

  private prepare(name: string): Statement {
    const cached = this.stmts.get(name);
    if (cached) return cached;
    const text = this.queries[name];
    if (!text) throw new Error(`Unknown SQL section: ${name}`);
    const stmt = this.db.prepare(text);
    this.stmts.set(name, stmt);
    return stmt;
  }

  private write(name: string, params: readonly unknown[] = []): void {
    this.prepare(name).run(...params);
  }
  private readOne<T>(name: string, params: readonly unknown[] = []): T | undefined {
    return this.prepare(name).get(...params) as T | undefined;
  }
  private readAll<T>(name: string, params: readonly unknown[] = []): T[] {
    return this.prepare(name).all(...params) as T[];
  }

  upsertProject(project: Project): void {
    this.write("upsertProject", [project.id, project.name, project.root]);
  }
}
```

Reuse public read methods inside other methods (e.g. `registerCollection`
calling `this.getCollectionIdentity(name)`) instead of duplicating the
underlying query call.

## `never` for terminal CLI commands

Functions that always throw or `process.exit(...)` should return `never`.
TypeScript then knows callers don't get a return value, and the intent reads
better than `void` for stub commands.

```typescript
function unimplemented(name: string, note?: string): never {
  console.error(`loctx ${name}: not yet implemented${note ? ` ${note}` : ""}`);
  process.exit(2);
}
```

## Typed CLI context, not `any`

Don't pass commander/yargs `context` or `argv` around as untyped objects.
Define a frozen interface at the entrypoint and hand it to commands.

```typescript
interface CliContext {
  readonly configPath: string;
  readonly debug: boolean;
}

const program = new Command()
  .option("--config <path>", "Path to config")
  .option("--debug", "Verbose logging")
  .hook("preAction", (cmd) => {
    const opts = cmd.opts();
    cmd.setOptionValue("ctx", {
      configPath: opts["config"] ?? defaultConfigPath(),
      debug: opts["debug"] === true,
    } satisfies CliContext);
  });
```

`satisfies` enforces the type without widening the literal.

## Branded types for IDs

Don't pass project IDs, file IDs, etc. as raw `string` — they get swapped
silently. Use branded types (a.k.a. nominal types via intersection) so the
type checker rejects mixups.

```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };

export type ProjectId = Brand<string, "ProjectId">;
export type FileId    = Brand<string, "FileId">;
export type ChunkId   = Brand<string, "ChunkId">;

export const projectId = (raw: string): ProjectId => raw as ProjectId;
```

`projectId("abc")` produces a `ProjectId`. Passing a `FileId` where a
`ProjectId` is expected fails to compile.

## Discriminated unions for state and results

Express "outcomes with mutually-exclusive shapes" as discriminated unions,
not boolean flags + nullable fields.

```typescript
type FileIndexResult =
  | { readonly kind: "indexed"; readonly relPath: string; readonly chunks: number }
  | { readonly kind: "skipped"; readonly relPath: string; readonly reason: string }
  | { readonly kind: "error"; readonly relPath: string; readonly error: string };

function summarize(result: FileIndexResult): string {
  switch (result.kind) {
    case "indexed": return `${result.relPath}: ${result.chunks} chunks`;
    case "skipped": return `${result.relPath}: skipped (${result.reason})`;
    case "error":   return `${result.relPath}: error (${result.error})`;
  }
}
```

The compiler enforces exhaustiveness — no fallthrough, no missing branch.

## Readonly value types

Default to `Readonly<>`, `ReadonlyArray<>`, `ReadonlySet<>`, `ReadonlyMap<>`
for "this is just data" types. Use `Object.freeze` at the construction site
where mutation guards matter at runtime. Use `as const` to narrow object
literals.

```typescript
export interface FilteringRules {
  readonly maxFileSizeBytes: number;
  readonly followSymlinks: boolean;
  readonly ignoredDirs: ReadonlySet<string>;
  readonly secretGlobs: readonly string[];
}
```

## `as const` objects for stable codes (StrEnum equivalent)

When a category code is part of the public surface (CLI / logs / wire
format), use a frozen `as const` object plus a derived union type. Avoids
TypeScript `enum` (which has runtime quirks and inflated bundles).

```typescript
export const FilterReason = {
  OK: "ok",
  OUTSIDE_PROJECT: "outside-project",
  IGNORED_DIRECTORY: "ignored-directory",
  SECRET: "secret",
} as const;

export type FilterReason = (typeof FilterReason)[keyof typeof FilterReason];
```

## Lazy heavy imports via dynamic `import()`

If a module pulls in something heavy (chromadb-style native bindings, ML
SDKs, headless browsers) but only uses it inside one class, defer the import.

```typescript
export class VectorStore {
  private client?: import("chromadb").PersistentClient;

  async init(chromaDir: string): Promise<void> {
    const { PersistentClient } = await import("chromadb");
    this.client = new PersistentClient({ path: chromaDir });
  }
}
```

The bare `import("chromadb").PersistentClient` in the type position costs
nothing at runtime (TypeScript erases it). Only the awaited `import()` runs.

## Const-then-test pattern (walrus equivalent)

JavaScript supports assignment expressions, but they hurt readability. Use
the const-then-test pattern instead:

```typescript
// Idiomatic
const size = v.getInt(data, "maxBytes", { nonNegative: true });
if (size !== undefined) acc.maxBytes = size;

// Don't do this — clever but harder to read
let size: number | undefined;
if ((size = v.getInt(data, "maxBytes", { nonNegative: true })) !== undefined) {
  acc.maxBytes = size;
}
```

## `Array.reduce` for simple folds

When you'd otherwise write `let acc = init; for (const x of xs) acc = f(acc, x)`,
use `xs.reduce(f, init)`. Don't use `.reduce` to build an object — that's a
red flag for "should be a `for...of` loop with `Object.assign` or a typed
helper."

## `Iterable<T>` / `AsyncIterable<T>` in input signatures

Accept `Iterable<T>` for one-pass inputs; return concrete `T[]` /
`ReadonlyArray<T>`. Lets callers pass generators and avoids forcing
realization upstream. For streamed work, `AsyncIterable<T>` + `for await...of`.

```typescript
export function extendUnique<T>(items: Iterable<T>, extras: Iterable<T>): T[] {
  return [...new Set([...items, ...extras])];
}

export async function* iterFiles(root: URL): AsyncIterable<URL> {
  for await (const entry of fs.opendir(fileURLToPath(root))) {
    if (entry.isFile()) yield new URL(entry.name, root);
  }
}
```

## Result types for expected failures

For operations where failure is part of the contract (file IO, parsing,
network), return a discriminated union `{ ok: true; value: T } | { ok: false; error: E }`
instead of throwing. Reserve thrown exceptions for programmer errors and
unexpected failures.

```typescript
type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

async function readJson<T>(path: string): Promise<Result<T>> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
```

Pair with discriminated-union exhaustiveness so you can't forget the error
branch.

## Latest language features

Target a recent TS version and ES2022+; reach for these over older equivalents.

- **`using` / `await using`** (explicit resource management) with
  `[Symbol.dispose]` / `[Symbol.asyncDispose]` for deterministic cleanup —
  prefer over manual try/finally for disposables.
- **`const` type parameters** — `function of<const T>(x: T)` to preserve literal
  types without `as const` at every call site.
- **`satisfies`** for type-checked literals that keep their narrow type;
  **`as const`** for readonly literal narrowing.
- **Discriminated unions + exhaustive `switch`** with a `never` default
  (`const _: never = x`) — the compiler enforces every case (see that section).
- **Generics with constraints and defaults** — `<T extends X = Y>`; variadic
  tuple types and template-literal types for typed keys/paths.
- **Utility & mapped types** — `Pick`, `Omit`, `Partial`, `Required`, `Record`,
  `ReturnType`, `Awaited`, key remapping (`as` clauses) over hand-written shapes.
- **`NoInfer<T>`** to block unwanted inference at a call site.
- **Top-level `await`**, ESM imports with `.js` extensions, `node:` built-ins.
- **`structuredClone`**, `Array.prototype.flatMap`, iterator helpers, `Object.groupBy` /
  `Map.groupBy`, and `Promise.allSettled` / `Promise.any` over hand-rolled equivalents.

## Software-engineering principles (in TypeScript)

The named principles map onto concrete TS mechanisms; most are already encoded in
the patterns above — this section names them and fills gaps. Reference an existing
pattern rather than restating it (DRY).

- **Abstraction & interfaces** — program to an `interface` / `type` contract, not a
  class. Accept the narrowest input type (`Iterable<T>`, `Readonly<>`), depend on the
  Spec contract, not its implementation.
- **Encapsulation** — `private` / `#private` fields, `readonly` value types, branded
  IDs to prevent illegal construction; never hand back a mutable internal array —
  return `ReadonlyArray<T>` or a frozen copy.
- **Dependency inversion / injection** — inject collaborators via constructor
  (`errorCtor`, `db`, `queries`) instead of importing/constructing inside. That's what
  makes `Validator` and `StateStore` testable.
- **Composition over inheritance** — compose Spec objects, injected callbacks, and
  Record-dispatch tables over class hierarchies. Use mixins/delegation when sharing
  behavior; inherit only for genuine is-a.
- **Open/Closed** — extend by adding a Spec constant, a `Record` dispatch entry, or a
  union member — never by editing the dispatcher or validator core.
- **DRY / no logic duplication** — extract generic helpers at 2+ uses
  (`extendUnique<T>`, `subtract<T>`); reuse public read methods internally; one rule
  per Spec. Collapse the same rule written differently, not just identical text.
- **Separation of concerns** — SQL in `.sql`, schemas in zod/`.yaml`, config loading
  apart from domain logic, CLI context (`CliContext`) apart from command bodies.
- **Aspect-oriented / cross-cutting** — factor logging, caching, retries, timing, and
  validation into higher-order wrappers, decorators, or middleware (e.g. an
  `withRetry(fn)` wrapper), not inline at every call site.
- **Callable abstractions** — model strategies/callbacks as function types passed in
  (`typeCheck`, `convert` on `Spec` are exactly this); higher-order functions over flags.
- **Config separation** — no magic values inline; load `process.env` once at the
  entrypoint, validate with zod, pass typed config down (see Layered configuration).
- **Generics** — type parameters with constraints so one implementation serves every
  type (`Spec<T>`, `Validator.get<T>`, `readOne<T>`) instead of per-type copies.

## Anti-patterns (kill on sight)

- `any` — replace with `unknown` and narrow.
- `obj[stringKey]` indexing without `noUncheckedIndexedAccess` (it returns
  `T` instead of `T | undefined`).
- `as Foo` casts followed by manual validation — invert: validate first,
  trust the type after.
- `Object.assign` to "merge defaults" without a typed schema — use zod or
  the Validator + Spec pattern.
- Inline SQL in template literals across multiple methods — move to a
  `.sql` file.
- TypeScript `enum` — use `as const` objects + derived union types.
- `Promise.all` with non-array iterables — wrap in `Array.from` first.
- (Node/server) `setTimeout` / `setInterval` to poll a stream or long-lived
  resource — prefer `AbortController` + `AsyncIterable` / event-driven push.
  This does **not** apply to React/client code: interval polling inside a
  hook (a `useEffect` that sets an interval and clears it on cleanup, gated
  on whether there's anything to poll) is the idiomatic way to refresh
  user-visible state there.
- `try { ... } catch {}` empty catch blocks.
- Mutable default parameters: `function f(items = [])` — fine in JS because
  defaults re-evaluate, **but** `function f(items: string[] = []) { items.push(...); }`
  invites caller-shared mutation. Use `readonly string[]` types.
- `process.env.X` scattered across the codebase — load once at the
  entrypoint, validate with zod, pass typed config down.
- Magic numbers/strings, hard-coded paths/URLs/credentials inline — hoist to
  named constants or typed config.
- Cross-cutting logic (logging, retries, timing) copy-pasted at call sites
  instead of a higher-order wrapper/decorator.
- Deep `class extends` chains where a Spec/strategy, injected callback, or
  union type composes cleaner.
- Boolean-flag + nullable-field state that a discriminated union expresses better.
- Public methods returning mutable internal arrays — return `ReadonlyArray<T>`.
- The same rule re-implemented in two places written differently — collapse to one.

## When to break these rules

- Small Node CLI scripts (< 200 lines) don't need a `Validator`, branded
  types, or external SQL files. The infrastructure cost outweighs the benefit.
- Match surrounding code style when editing an existing module — don't
  introduce these patterns mid-file just because. Land them on a refactor
  pass with tests.
- Browser-only code may need different lazy-load strategies (dynamic
  `import()` is fine, but `node:` built-ins won't work). Most patterns above
  apply unchanged.
