/**
 * Typed dict-key validators shared across loctx config loaders.
 *
 * Public API mirrors `Record.get` semantics:
 *
 *     v.get(data, key, spec)              -> T | undefined
 *     v.get(data, key, spec, defaultValue) -> T
 *
 * Plus terse typed shortcuts for the common cases:
 *
 *     v.getInt(data, key)                 -> number | undefined
 *     v.getBool(data, key)                -> boolean | undefined
 *     v.getStr(data, key)                 -> string | undefined
 *     v.getStrArray(data, key)            -> readonly string[] | undefined
 *
 * A `Spec<T>` is a strategy: a type-check predicate, the expected-type label
 * used in error messages, and an optional converter (e.g. defensively copy
 * an array). New accepted types add a single Spec constant — no change to
 * Validator.
 */

export interface Spec<T> {
  readonly typeCheck: (value: unknown) => boolean;
  readonly expected: string;
  readonly convert?: (value: unknown) => T;
}

// ---- built-in specs ----------------------------------------------------

export const INT: Spec<number> = {
  typeCheck: (v) => typeof v === "number" && Number.isInteger(v),
  expected: "an integer",
};

export const INT_NON_NEG: Spec<number> = {
  typeCheck: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
  expected: "a non-negative integer",
};

export const NUM: Spec<number> = {
  typeCheck: (v) => typeof v === "number" && Number.isFinite(v),
  expected: "a finite number",
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
  convert: (v) => Object.freeze([...(v as string[])]),
};

// ---- Validator ---------------------------------------------------------

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
    if (!Object.hasOwn(data, key)) return defaultValue;
    const value = data[key];
    if (!spec.typeCheck(value)) {
      throw this.makeError(`${key} must be ${spec.expected}`);
    }
    return spec.convert ? spec.convert(value) : (value as T);
  }

  // Typed shortcuts — each is a one-line delegate to get().
  getInt(
    data: Record<string, unknown>,
    key: string,
    opts?: { readonly nonNegative?: boolean },
  ): number | undefined {
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

  /** Confirm `value` is an object (not array/null), return as `Record<string, unknown>`. */
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
