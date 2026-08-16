---
name: code-style
description: Apply functional programming style, modern language features, and core software-engineering principles when writing or editing code. Pure functions, immutable data, comprehensions, early returns, latest syntax, a full deep-nesting remediation toolkit (guard clauses through dispatch tables, strategy objects, and state machines), plus DRY, SoC, encapsulation, abstraction, composition over inheritance, generics, and config separation. Auto-loads on any code-editing task in Python, TypeScript, or JavaScript. Skip for prose, configuration files, and generated code.
---

# Code Style

Prefer functional programming style, the newest language constructs available, and
the engineering principles below. This skill is the language-agnostic layer; for
architectural patterns see the companion `python` and `typescript` skills.

## Python (latest features)

- Start every module with `from __future__ import annotations`.
- Use union syntax: `str | None`, not `Optional[str]`.
- Reach for `match` / `case` (incl. structural patterns, guards) over chained `if/elif` on type or value.
- Use the walrus operator (`:=`) when it tightens a loop.
- Prefer `next(g for g in ...)` over loop-with-break.
- List, set, and dict comprehensions over imperative append loops.
- `frozenset` for immutable sets; `tuple` over `list` for fixed sequences.
- Compile regex patterns once at module level for reuse.
- Use `pathlib.Path`, never `os.path` strings.
- Prefer dataclasses (`frozen=True, slots=True`) or `TypedDict` over plain dicts for structured data.
- Generics via PEP 695 syntax: `def first[T](xs: list[T]) -> T`, `class Box[T]`, `type Alias[T] = ...`.
- `typing.Protocol` for structural interfaces; `@runtime_checkable` only when needed.
- `enum.Enum` / `StrEnum` for closed value sets, not bare string constants.
- `functools` (`cache`, `partial`, `reduce`, `singledispatch`) and `itertools` over hand-rolled loops.
- `contextlib` (`contextmanager`, `ExitStack`, `suppress`) for resource and cleanup logic.
- `ExceptionGroup` / `except*` for concurrent error handling; `asyncio.TaskGroup` over bare `gather`.
- `Self` return type for fluent/builder methods; `Final` for constants; `Literal` for narrow values.

## TypeScript / JavaScript (latest features)

- `const` over `let`. Never `var`.
- Arrow functions over function declarations.
- `.map()` / `.filter()` / `.reduce()` / `.flatMap()` over `for` loops.
- Optional chaining (`?.`) and nullish coalescing (`??`, `??=`).
- `satisfies` for type-checked literals; `as const` for narrow literal types.
- Template literals over string concatenation.
- Destructuring at function signatures; default and rest parameters.
- Generics with constraints and defaults: `<T extends X = Y>`; `const` type parameters.
- Discriminated unions + exhaustive `switch` with a `never` default for closed sets.
- Utility types (`Pick`, `Omit`, `Partial`, `Record`, `ReturnType`, template literal types).
- `interface` / `type` for contracts; program to the type, not the implementation.
- Iterator helpers and `Array.from`/`Object.entries` over index loops.
- Top-level `await`, ESM imports, `using`/`await using` for disposables.
- `structuredClone` and immutable update patterns over in-place mutation.

## Functional core

- Pure functions over mutation; isolate side effects at the edges.
- Expressions over statements.
- Comprehensions, generators, and higher-order functions (map/filter/reduce, lambdas/callables) over manual loops.
- First-class and higher-order functions: pass behavior as callables rather than branching on flags.
- Early returns over deep nesting.
- Immutable data structures where practical.

## Software-engineering principles

- **Abstraction** — expose intent, hide mechanism. Name the *what*; bury the *how*.
- **Encapsulation** — keep state private; mutate through methods/functions, not by reaching in. No public mutable internals.
- **Interfaces & contracts** — depend on `Protocol`/`interface`/abstract types, not concrete classes (dependency inversion). Program to an interface.
- **Composition over inheritance** — assemble behavior from small parts; favor mixins/strategies/delegation over deep class trees. Inherit only for genuine is-a.
- **Separation of concerns** — one module/function = one responsibility. Keep I/O, business logic, and presentation in separate layers.
- **DRY / no logic duplication** — a rule lives in exactly one place. Eliminate duplication even when the two copies are *written differently* (same logic, different shape still counts). Extract the shared concept, not just the shared text.
- **Single responsibility & small units** — functions do one thing; split when a name needs "and".
- **Config separation** — no magic values or environment specifics inline. Constants at module top; secrets/env/tunables in config files or env vars, never hard-coded.
- **Generics** — write code once over a type parameter instead of copy-pasting per type.
- **Aspect-oriented / cross-cutting concerns** — factor logging, caching, retries, auth, validation, and timing into decorators/middleware/wrappers, not scattered inline at every call site.
- **Callable abstractions** — model strategies and callbacks as functions/callables passed in, enabling open/closed extension without editing the core.
- **Open/Closed** — extend behavior by adding new implementations, not by editing stable code.
- **Cohesion & coupling** — high cohesion within a unit, loose coupling between units. Inject dependencies; avoid hidden globals.
- **Law of least surprise** — predictable names, consistent return shapes, no side effects hidden behind innocent-looking getters.

## Flattening deep nesting (the full toolkit)

Early returns are the FIRST tool for a nesting finding, not the whole
fix. Work down this list and pick the shape that matches why the code
nests; often the right fix replaces the conditional tree with a data
structure rather than relocating it.

1. **Guard clauses / early returns** — invert `if (ok) { ... }` into
   `if (!ok) return`; in loops, `continue` instead of wrapping the body.
   Handles incidental nesting only.
2. **Extract named functions** — when a nested block does one nameable
   thing. Extraction moves nesting; pick it when the NAME carries value.
3. **Dispatch tables** — a `dict` / `Record` keyed by the discriminant,
   values are handlers or config rows. Replaces `if/elif` and `switch`
   pyramids that branch on a value. Adding a case becomes adding an
   entry (open/closed), and the table is testable data.
4. **Table-driven / declarative design** — when the branches differ only
   in parameters, encode the variation as rows (spec objects, rule
   tables) consumed by one small engine. The descriptor-table pattern:
   the logic runs once, the cases are data.
5. **Strategy objects / classes** — when the varying behavior has state
   or several cooperating methods, a small class (or closure factory)
   per case behind a common interface beats a branch tree. Composition,
   not inheritance depth.
6. **Discriminated unions + exhaustive match** — when nesting comes from
   interrogating a shape (`match`/`case` in Python, tagged unions with
   exhaustive `switch` in TS). The compiler then polices the cases.
7. **State machines** — when nesting encodes a lifecycle (`if running
   and not paused and ...`), name the states, store one, and transition
   explicitly.
8. **Flatten async/error pyramids** — `async`/`await` over nested
   callbacks/`.then`; one try/except (or Result type) at the right
   altitude over per-line handling.

A complexity-analyzer finding (deep nesting, high cyclomatic
complexity) is a prompt to choose from this WHOLE list — reach for the
data-structure fixes (3–5) whenever the same discriminant is tested
more than twice.

## Anti-patterns (kill on sight)

- Mutating function parameters or shared global state.
- Loops that build a list with `.append`/`.push` when a comprehension or `.map` works.
- Deep `if`/`else` pyramids without early returns.
- `let` declarations that never reassign.
- Type-asserted-then-checked-anyway code (`x as Foo` followed by manual validation).
- Bare `except:` (Python) or `catch (e)` that swallows errors silently.
- String-concatenated SQL or HTML (use parameterized queries / template engines).
- Duplicated logic across functions/files — including the same rule re-expressed differently.
- Magic numbers/strings and hard-coded paths, URLs, or credentials inline.
- Cross-cutting concerns (logging, retries, auth) copy-pasted at every call site instead of factored out.
- Deep inheritance hierarchies where composition would do.
- God objects/functions that mix unrelated concerns.
- Leaky abstractions that expose internal representation to callers.

## Apply judgment

These are defaults, not laws. Break them when the alternative is clearer or
when matching surrounding code style. Prefer the simplest design that satisfies
the principles — don't over-abstract for a single use (YAGNI). The goal is
readable, maintainable code, not a checklist.
