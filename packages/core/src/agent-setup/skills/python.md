---
name: python
description: Apply loctx-flavored Python architectural patterns when writing or editing Python. Validator classes for typed dict checks, external SQL/YAML resources, layered config with explicit removals, dict-keyed dispatch over getattr/setattr, _write/_read DB helpers, NoReturn-typed terminal functions, frozen-slots dataclasses, lazy heavy imports, strict mypy, plus latest language features and core SE principles (abstraction, encapsulation, DRY, SoC, composition over inheritance, generics). Auto-loads on Python edits. Pairs with the code-style skill (which covers functional idioms).
---

# Python patterns

These are the architectural patterns to default to in Python projects. They
complement the `code-style` skill (functional idioms, modern syntax). Apply
the rules below when adding non-trivial code; skip them for one-off scripts.

## Strict mypy is the contract

- Run with `mypy --strict`. Treat warnings as errors.
- `# type: ignore[<code>]` only as a last resort, with the specific code.
  Drop it the moment it stops being needed.
- `from __future__ import annotations` at the top of every module.

## Validate untrusted dicts through a Validator + Spec strategy

When loading TOML, YAML, JSON, or any user-supplied mapping, route every
type check through one bound validator. The API mirrors `dict.get` and uses
**`Spec[T]` strategy objects** so adding a new accepted type means defining
one constant — never modifying Validator.

```python
@dataclass(frozen=True, slots=True)
class Spec[T]:
    type_check: Callable[[Any], bool]
    expected: str                                  # error label: "must be {expected}"
    converter: Callable[[Any], Any] | None = None  # e.g. list, to defensively copy

    def convert(self, value: Any) -> Any:
        return self.converter(value) if self.converter is not None else value


# Module-level Spec constants — add new types here, no Validator changes.
INT          = Spec[int](lambda v: isinstance(v, int) and not isinstance(v, bool), "an integer")
INT_NON_NEG  = Spec[int](lambda v: isinstance(v, int) and not isinstance(v, bool) and v >= 0, "a non-negative integer")
BOOL         = Spec[bool](lambda v: isinstance(v, bool), "a boolean")
STR          = Spec[str](lambda v: isinstance(v, str), "a string")
STR_LIST     = Spec[list[str]](
    lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v),
    "a list of strings",
    converter=list,
)


class Validator:
    __slots__ = ("error_cls", "source")

    def __init__(self, error_cls: type[Exception], *, source: str = "") -> None:
        self.error_cls = error_cls
        self.source = source

    # dict.get-style core: overloaded so types narrow on default.
    @overload
    def get[T](self, data: Mapping[str, Any], key: str, spec: Spec[T]) -> T | None: ...
    @overload
    def get[T](self, data: Mapping[str, Any], key: str, spec: Spec[T], default: T) -> T: ...
    def get(self, data, key, spec, default=_SENTINEL):
        if key not in data:
            return None if default is _SENTINEL else default
        value = data[key]
        if not spec.type_check(value):
            raise self._err(f"{key} must be {spec.expected}")
        return spec.convert(value)

    # Typed shortcuts — each is a one-line delegate to get().
    def get_int(self, data, key, *, non_negative=False) -> int | None:
        return self.get(data, key, INT_NON_NEG if non_negative else INT)
    def get_bool(self, data, key) -> bool | None:
        return self.get(data, key, BOOL)
    def get_str(self, data, key) -> str | None:
        return self.get(data, key, STR)
    def get_str_list(self, data, key) -> list[str] | None:
        return self.get(data, key, STR_LIST)

    def require_mapping(self, value, *, label) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise self._err(f"{label} must be a mapping")
        return {str(k): v for k, v in value.items()}

    def _err(self, msg: str) -> Exception:
        return self.error_cls(f"{self.source}: {msg}" if self.source else msg)
```

**Call sites** — pick the form that reads best:

```python
v = Validator(MyDomainError, source=str(path))

# Typed shortcuts: terse, returns T | None
size   = v.get_int(data, "max_bytes", non_negative=True)
flag   = v.get_bool(data, "enabled")
extras = v.get_str_list(data, "extra_paths")

# Generic form with default: parallels dict.get(key, default), returns T
provider = v.get(data, "provider", STR, "anonymous")
debounce = v.get(data, "debounce_ms", INT, 500)

# Generic form for custom Specs (no shortcut needed)
EVEN_INT = Spec[int](
    lambda v: isinstance(v, int) and not isinstance(v, bool) and v % 2 == 0,
    "an even integer",
)
n = v.get(data, "step", EVEN_INT)
```

**Why this shape**:
- `dict.get` semantics for free — `v.get(data, key, spec)` returns `T | None`,
  `v.get(data, key, spec, default)` returns `T`. Familiar and overload-typed.
- Spec strategy: validation logic lives in one constant per type. Validator
  itself is closed for modification, open for extension.
- Typed shortcuts (`get_int`/`get_bool`/`get_str`/`get_str_list`) are 1-line
  delegates — they exist purely so mypy can narrow the return type cleanly
  at common call sites.
- `non_negative` is a kwarg on `get_int` (the most common variant); rarer
  constraints become their own Spec constant rather than another kwarg.
- `source` is prefixed onto every error message so users can find the
  failing file fast.
- `converter` lets a Spec defensively copy data (e.g. `list` for input lists
  loaded from YAML) so callers can't mutate the original dict.

## External resources over inline strings

- **SQL** belongs in `.sql` files inside a `sql/` package. Use named-section
  markers (`-- :name <ident>`) and a small loader returning `Mapping[str, str]`.
  Reference queries by name in code.
- **Config schemas / defaults** belong in `.yaml` files inside a `data/` package.
  Bundle with the package; load via `importlib.resources.files(...)`.
- Heredoc-style multi-line strings in Python for SQL/HTML/JSON are an
  anti-pattern — they hide the content from syntax highlighting, formatters,
  and grep.

## Layered configuration

When a config has bundled defaults plus user overrides:

1. Read package defaults first.
2. Read user overrides from a directory (`*.yaml` and `*.yml`), sorted
   alphabetically so users can prefix with `10-`, `20-` to control merge
   order.
3. **List keys**: extend (dedupe-preserving-order). Provide `remove_<key>`
   for explicit subtraction so a typo never silently drops a baseline entry.
4. **Scalar keys**: replace.
5. **Unknown keys**: raise. Don't silently ignore — a typo is almost always
   a misconfiguration the user wants to know about.
6. Reject deprecated config sections with a message that points at the new
   location, not just an error code.

## Dict-keyed dispatch over getattr/setattr

If you find yourself writing `getattr(obj, key)` and `setattr(obj, key, ...)`
in a loop over a tuple of field names, refactor: move those fields into a
single `dict[str, T]` on the dataclass. The loop body collapses.

```python
# Before
for key in _LIST_KEYS:
    existing = set(getattr(acc, key))
    ...
    setattr(acc, key, [...])

# After
for key in _LIST_KEYS:
    if (extras := source.get(key)) is not None:
        acc.lists[key] = extend_unique(acc.lists[key], extras)
```

## Pure helpers (rule of three)

When a 2-3 line idiom recurs and a name would make it clearer, extract it
as a named pure function. Default to the **rule of three**: two copies is a
watch signal, the *third* use is the trigger — premature abstraction is
worse than a little duplication, and a forced helper carrying 3+ params to
satisfy a hypothetical caller is a net loss. Exceptions: a short
*byte-identical* block (e.g. a 30-line test fixture) is worth sharing at
two; a 2-3 line idiom that's only superficially similar usually isn't.
When a project sets its own threshold (e.g. loctx's "extract before the
third caller"), that wins. Good candidates: list/set ops with semantic
intent.

```python
def extend_unique(items: Iterable[str], extras: Iterable[str]) -> list[str]:
    """Append extras to items, dedupe, preserve order."""
    return list(dict.fromkeys((*items, *extras)))

def subtract(items: Iterable[str], removals: Iterable[str]) -> list[str]:
    drop = set(removals)
    return [item for item in items if item not in drop]
```

`dict.fromkeys(...)` is the idiomatic ordered-dedupe.

## Database access: `_write` / `_read_one` / `_read_all` helpers

For any class that wraps a SQLite/Postgres connection, centralize the
execute-and-commit pattern in three private helpers. Public methods become
one-liners:

```python
def _write(self, query_name: str, params: Sequence[Any] = ()) -> None:
    self._conn.execute(_QUERIES[query_name], params)
    self._conn.commit()

def _read_one(self, query_name, params=()) -> tuple[Any, ...] | None: ...
def _read_all(self, query_name, params=()) -> list[tuple[Any, ...]]: ...

def upsert_project(self, project: Project) -> None:
    self._write("upsert_project", (project.id, project.name, str(project.root)))
```

Reuse public read methods inside other methods (e.g. `register_collection`
calling `self.get_collection_identity(name)`) instead of duplicating the
underlying query call.

## `NoReturn` for terminal CLI commands

Click commands that always raise `Exit` should be typed `-> NoReturn`. mypy
then knows callers don't get a return value, and an explicit "I never come
back" reads better than `-> None` for stub commands.

```python
def _unimplemented(name: str, *, note: str = "") -> NoReturn:
    suffix = f" {note}" if note else ""
    click.echo(f"loctx {name}: not yet implemented{suffix}")
    raise click.exceptions.Exit(code=2)
```

## Typed CLI context dataclass

Don't pass Click's `ctx.obj` around as `dict[str, object]` with `isinstance`
asserts in every command. Build a frozen dataclass at the entrypoint and
hand commands the typed object via `@click.pass_obj`:

```python
@dataclass(frozen=True, slots=True)
class _CliContext:
    config_path: Path
    debug: bool

@click.group()
@click.pass_context
def main(ctx, config_path, debug):
    ctx.obj = _CliContext(config_path=config_path, debug=debug)

@main.command()
@click.pass_obj
def status(cli_ctx: _CliContext) -> None:
    ...
```

Drop `@click.pass_obj` from commands that don't need the context — don't
keep an unused parameter.

## Frozen dataclasses with `slots=True` for value types

Default to `@dataclass(frozen=True, slots=True)` for any "this is just data"
class — config, decisions, models, query requests/responses. Mutable `slots`
dataclasses for accumulators and builders.

## `StrEnum` for stable codes that surface in CLI / logs

When a category code is part of the public surface (e.g. filter-skip
reasons rendered by `loctx doctor`), use `StrEnum`. Comparisons stay typed,
serialization stays human-readable.

```python
class FilterReason(StrEnum):
    OK = "ok"
    OUTSIDE_PROJECT = "outside-project"
    SECRET = "secret"
```

## Lazy import for heavy dependencies

If a module imports something heavy (chromadb, torch, sentence-transformers)
but only uses it inside one class, defer the import to that class's
`__init__`. Keeps tools that just want to type-check or read the module
fast.

```python
class VectorStore:
    def __init__(self, ...) -> None:
        # Lazy: chromadb pulls in ML deps.
        import chromadb
        self._client = chromadb.PersistentClient(...)
```

## Walrus binding for the optional-and-test pattern

```python
# Before
unknown = set(data.keys()) - _ALLOWED
if unknown:
    raise Error(...)

# After
if unknown := set(data.keys()) - _ALLOWED:
    raise Error(...)
```

```python
# Before
size = v.optional_int(data, "size")
if size is not None:
    acc.size = size

# After
if (size := v.optional_int(data, "size")) is not None:
    acc.size = size
```

## `functools.reduce` for simple folds

When you'd otherwise write `init = ...; for x in xs: init = init + x`, use
`reduce(operator.add, xs)`. Guard the empty case explicitly:

```python
return reduce(operator.add, specs) if specs else None
```

## Iterables, not lists, in input signatures

Accept `Iterable[X]` for one-pass inputs; return concrete `list[X]` /
`tuple[X, ...]`. Lets callers pass generators and avoids forcing realization
upstream.

## Latest language features

Target the newest interpreter the project supports; reach for these over older equivalents.

- **PEP 695 generics** — `def first[T](xs: list[T]) -> T`, `class Box[T]`,
  `type Alias[T] = ...`. No more `TypeVar` boilerplate. Use `[T: Bound]` for
  constraints and `[*Ts]` / `[**P]` for variadic and param specs.
- **Structural `match`** — class patterns, mapping/sequence patterns, `|` or-patterns,
  and guards (`case Point(x, y) if x == y:`). Prefer over `isinstance` ladders.
- **`typing.Protocol`** for structural interfaces; `@runtime_checkable` only when an
  actual `isinstance` check is needed.
- **`enum.StrEnum` / `IntEnum`** for closed code sets (see the StrEnum section).
- **`asyncio.TaskGroup`** over bare `gather`; `ExceptionGroup` + `except*` for
  concurrent failures; `contextlib.AsyncExitStack` for async resource stacks.
- **`Self`** return type for fluent/builder methods; **`Final`** for module constants;
  **`Literal`** for narrow value sets; **`assert_never`** for exhaustive `match`.
- **`functools`** (`cache`, `cached_property`, `partial`, `singledispatch`, `reduce`)
  and **`itertools`** over hand-rolled loops.
- **`contextlib`** (`contextmanager`, `ExitStack`, `suppress`, `chdir`) for cleanup.
- **`tomllib`** (stdlib) for reading TOML — no third-party dep.

## Software-engineering principles (in Python)

The named principles map onto concrete Python mechanisms; most are already encoded
in the patterns above — this section names them and fills gaps. Don't re-derive an
existing pattern, reference it (DRY).

- **Abstraction & interfaces** — depend on `Protocol` / `abc.ABC`, not concrete
  classes. Type parameters as the interface (`Iterable[X]` inputs), return concrete
  types. Programs depend on the Spec/Validator contract, not its internals.
- **Encapsulation** — `frozen=True, slots=True` dataclasses for value types; leading
  underscore for private attrs and helpers (`_write`, `_read_one`); never expose a
  mutable internal list — hand back a copy or a `tuple`.
- **Dependency inversion / injection** — pass collaborators in (`error_cls`,
  `db conn`, `queries` mapping) rather than constructing or importing them inside.
  This is what makes the Validator and DB-helper patterns testable.
- **Composition over inheritance** — assemble behavior from Spec strategy objects,
  injected callables, and dict-dispatch tables instead of subclass hierarchies.
  Inherit only for genuine is-a (e.g. a domain `Exception` subclass).
- **Open/Closed** — extend by adding a Spec constant or a dispatch-table entry, never
  by editing the Validator or the dispatcher. New behavior = new data, not new branches.
- **DRY / no logic duplication** — extract a pure helper at 2+ uses (`extend_unique`,
  `subtract`); reuse public read methods inside other methods; one rule lives in one
  Spec. Collapse logic that is the same rule written differently, not just identical text.
- **Separation of concerns** — SQL in `.sql`, schemas/defaults in `.yaml`, config
  loading separate from domain logic, CLI wiring (`_CliContext`) separate from commands.
- **Aspect-oriented / cross-cutting** — factor logging, caching, retries, timing,
  and validation into decorators (`@cache`, `@contextmanager`, custom `@retry`) or a
  shared base, not inline at every call site.
- **Callable abstractions** — model strategies and callbacks as `Callable` /
  `Protocol` passed in (the `type_check` and `converter` on `Spec` are exactly this);
  `functools.singledispatch` for open type-based dispatch.
- **Config separation** — constants `Final` at module top; tunables/secrets in
  layered YAML or env, never hard-coded inline (see Layered configuration).
- **Generics** — PEP 695 type parameters so one implementation serves every type
  (`Spec[T]`, `Validator.get[T]`) instead of per-type copies.

## Anti-patterns (kill on sight)

- `getattr(obj, str_key)` / `setattr(obj, str_key, ...)` in a loop — refactor
  to a `dict` field.
- `if "x" in d: v = d["x"]; if not isinstance(v, X): raise ...` repeated for
  each key — use a `Validator`.
- SQL strings in `"""..."""` blocks across multiple methods — move to a
  `.sql` file.
- Click commands that take `obj: dict[str, object]` and `assert isinstance` —
  use a typed `_CliContext` dataclass.
- `# type: ignore` without a code suffix.
- `cur.fetchone()[<int>]` for column access scattered across methods —
  centralize via `_read_one` / `_read_all` and a `_X_from_row` helper, OR
  switch to `sqlite3.Row` and access by column name.
- Mutable default args (`def f(items=[])`) — always `None` + sentinel.
- Magic numbers/strings, hard-coded paths/URLs/credentials inline — hoist to
  `Final` constants or layered config.
- Cross-cutting logic (logging, retries, timing) copy-pasted at call sites
  instead of a decorator/context manager.
- Deep inheritance trees where a Spec/strategy or injected callable composes cleaner.
- `isinstance` ladders that a `match` or `singledispatch` expresses better.
- The same rule re-implemented in two places written differently — collapse to one.

## When to break these rules

- Genuinely simple scripts (< 100 lines) don't need a `Validator` or
  external SQL files. The infrastructure cost outweighs the benefit.
- Match surrounding code style when editing an existing module — don't
  introduce these patterns mid-file just because. Land them on a refactor
  pass with tests.
