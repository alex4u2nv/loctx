/**
 * Cheap AST metadata extraction (#59). Walks the same tree-sitter parse the
 * chunker already runs, so there's no extra scan cost per file.
 *
 * v1 fields: imports, exports, calls, paramCount, hasAsync,
 * maxNestingDepth. The remaining `AnalyzerMetadata` fields
 * (`maxLoopDepth`, `hasRecursionHint`, `riskyCalls`) get conservative
 * defaults; their extractors can land in a follow-up without breaking the
 * schema.
 *
 * Per-language node-type maps are deliberately small. Tree-sitter grammars
 * don't share names; we hard-code the few node types that matter for each
 * language we support, and fall back to "no metadata" for grammars we
 * don't recognize.
 */

import type { AnalyzerMetadata, SymbolRefKind } from "../models.js";

export const ANALYZER_VERSION = 1;

/**
 * Lowercased identifier tokens that flag a chunk as performing a
 * potentially risky operation (subprocess, dynamic eval, raw HTML
 * injection). Used twice:
 *   - **Extract time:** intersect a chunk's `calls` to populate
 *     `analyzer.riskyCalls` so search-time scoring can read them
 *     cheaply (#277).
 *   - **Query time:** the searcher matches the same token list
 *     against incoming query text to figure out when to fire the
 *     `risky_call_category` match reason.
 *
 * Lives here (chunking layer) so the searcher can depend on it; the
 * reverse direction would couple chunking to retrieval.
 */
export const RISKY_CATEGORY_TOKENS: ReadonlyArray<string> = Object.freeze([
  "eval",
  "exec",
  "system",
  "child_process",
  "subprocess",
  "shell",
  "spawn",
  "execfile",
  "execsync",
  "spawnsync",
  "dangerouslysetinnerhtml",
]);

const RISKY_TOKEN_SET = new Set<string>(RISKY_CATEGORY_TOKENS);

/**
 * One identifier reference inside a chunk. Coordinates are absolute file
 * lines (1-based) so consumers can jump straight to the source. The
 * indexer assigns chunk_id/file_id/project_id when persisting; the
 * extractor only knows about (symbol, kind, line).
 */
export interface SymbolRefExtract {
  readonly symbol: string;
  readonly kind: SymbolRefKind;
  readonly line: number;
}

interface TreeSitterNode {
  readonly type: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly namedChildren: ReadonlyArray<TreeSitterNode>;
  readonly children: ReadonlyArray<TreeSitterNode>;
  childForFieldName(name: string): TreeSitterNode | null;
  readonly text: string;
}

/** Node-type sets per language for the patterns the analyzer cares about. */
interface LanguageProfile {
  readonly importNodes: ReadonlySet<string>;
  readonly exportNodes: ReadonlySet<string>;
  readonly callNodes: ReadonlySet<string>;
  readonly loopNodes: ReadonlySet<string>;
  readonly nestingNodes: ReadonlySet<string>;
  /** Node type that holds the parameter list under `field('parameters')`. */
  readonly parameterFields: ReadonlyArray<string>;
  /**
   * Node types that represent a class member. When the chunk root is a
   * class (or wraps one via `export class`), the walk emits a `def`
   * symbol_ref for each such member nested at depth > 0. Without this,
   * `find_usages` for class methods returned zero defs (#278) even
   * when the class itself was correctly recognised.
   */
  readonly methodDefNodes: ReadonlySet<string>;
}

const PROFILES: Readonly<Record<string, LanguageProfile>> = Object.freeze({
  python: {
    importNodes: new Set(["import_statement", "import_from_statement"]),
    exportNodes: new Set([]),
    callNodes: new Set(["call"]),
    loopNodes: new Set(["for_statement", "while_statement"]),
    nestingNodes: new Set([
      "function_definition",
      "class_definition",
      "if_statement",
      "for_statement",
      "while_statement",
      "with_statement",
      "try_statement",
    ]),
    parameterFields: ["parameters"],
    // In Python a method is just a function_definition inside a class
    // body. depth>0 ensures the chunk root (which findDefName handles)
    // isn't double-emitted.
    methodDefNodes: new Set(["function_definition", "async_function_definition"]),
  },
  javascript: {
    importNodes: new Set(["import_statement"]),
    exportNodes: new Set(["export_statement"]),
    callNodes: new Set(["call_expression"]),
    loopNodes: new Set([
      "for_statement",
      "for_in_statement",
      "for_of_statement",
      "while_statement",
      "do_statement",
    ]),
    nestingNodes: new Set([
      "function_declaration",
      "function_expression",
      "arrow_function",
      "method_definition",
      "class_declaration",
      "if_statement",
      "for_statement",
      "while_statement",
      "try_statement",
    ]),
    parameterFields: ["parameters"],
    methodDefNodes: new Set(["method_definition"]),
  },
  typescript: {
    importNodes: new Set(["import_statement"]),
    exportNodes: new Set(["export_statement"]),
    callNodes: new Set(["call_expression"]),
    loopNodes: new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]),
    nestingNodes: new Set([
      "function_declaration",
      "function_expression",
      "arrow_function",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "if_statement",
      "for_statement",
      "while_statement",
      "try_statement",
    ]),
    parameterFields: ["parameters"],
    methodDefNodes: new Set(["method_definition"]),
  },
  tsx: {
    importNodes: new Set(["import_statement"]),
    exportNodes: new Set(["export_statement"]),
    callNodes: new Set(["call_expression"]),
    loopNodes: new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]),
    nestingNodes: new Set([
      "function_declaration",
      "function_expression",
      "arrow_function",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "if_statement",
      "for_statement",
      "while_statement",
      "try_statement",
    ]),
    parameterFields: ["parameters"],
    methodDefNodes: new Set(["method_definition"]),
  },
  go: {
    importNodes: new Set(["import_declaration", "import_spec"]),
    exportNodes: new Set([]),
    callNodes: new Set(["call_expression"]),
    loopNodes: new Set(["for_statement"]),
    nestingNodes: new Set([
      "function_declaration",
      "method_declaration",
      "if_statement",
      "for_statement",
    ]),
    parameterFields: ["parameters"],
    // Go methods are top-level (`func (r *Foo) Bar()`), already
    // chunked by the chunker — no nested case to handle here.
    methodDefNodes: new Set([]),
  },
  rust: {
    importNodes: new Set(["use_declaration"]),
    exportNodes: new Set([]),
    callNodes: new Set(["call_expression"]),
    loopNodes: new Set(["for_expression", "while_expression", "loop_expression"]),
    nestingNodes: new Set([
      "function_item",
      "impl_item",
      "if_expression",
      "for_expression",
      "while_expression",
    ]),
    parameterFields: ["parameters"],
    // Rust impl blocks chunk separately. Methods inside an `impl` are
    // `function_item` at depth 1 — emit defs for them.
    methodDefNodes: new Set(["function_item"]),
  },
  java: {
    importNodes: new Set(["import_declaration"]),
    exportNodes: new Set([]),
    callNodes: new Set(["method_invocation"]),
    loopNodes: new Set([
      "for_statement",
      "while_statement",
      "do_statement",
      "enhanced_for_statement",
    ]),
    nestingNodes: new Set([
      "method_declaration",
      "class_declaration",
      "if_statement",
      "for_statement",
      "while_statement",
      "try_statement",
    ]),
    parameterFields: ["parameters", "formal_parameters"],
    methodDefNodes: new Set(["method_declaration"]),
  },
});

/**
 * Walk the tree-sitter parse rooted at `node` and return AnalyzerMetadata.
 * Returns null when the language doesn't have a profile.
 */
export function extractAnalyzer(node: TreeSitterNode, language: string): AnalyzerMetadata | null {
  const profile = PROFILES[language];
  if (profile === undefined) return null;

  const imports: string[] = [];
  const exports: string[] = [];
  const calls: string[] = [];
  let maxNestingDepth = 0;
  let maxLoopDepth = 0;
  let paramCount = 0;
  let hasAsync = false;

  // The chunk root is itself the function/class def — read its parameter
  // list once for the primary symbol. Doesn't recurse into nested
  // function defs (which would inflate paramCount).
  for (const fieldName of profile.parameterFields) {
    const params = node.childForFieldName(fieldName);
    if (params !== null) {
      paramCount = params.namedChildren.length;
      break;
    }
  }

  // Quick async detection — works because the chunk text contains the
  // keyword. Cheaper than walking node types per language.
  if (/\basync\b/.test(node.text.slice(0, 200))) hasAsync = true;

  walk(node, profile, {
    imports,
    exports,
    calls,
    nestingDepth: 0,
    loopDepth: 0,
    record: (depth, kind) => {
      if (kind === "nesting" && depth > maxNestingDepth) maxNestingDepth = depth;
      if (kind === "loop" && depth > maxLoopDepth) maxLoopDepth = depth;
    },
  });

  const dedupedCalls = dedupe(calls);
  // Surface any call whose lowercased name (or any dot-separated
  // suffix of it) matches a known risky category. This catches
  // `child_process.exec`, `subprocess.run`, plain `exec`, and the
  // React/JS-specific `dangerouslySetInnerHTML` JSX attribute.
  // Match-time scoring (see retrieval/searcher.ts) only fires the
  // `risky_call_category` reason when both query AND chunk mention
  // the same category, so a non-empty `riskyCalls` here is what
  // actually lights up the signal at query time. (#277)
  const riskyCalls = dedupedCalls.filter((c) => isRiskyCall(c));

  return Object.freeze({
    imports: Object.freeze(dedupe(imports)),
    exports: Object.freeze(dedupe(exports)),
    calls: Object.freeze(dedupedCalls),
    maxNestingDepth,
    maxLoopDepth,
    paramCount,
    hasAsync,
    hasRecursionHint: false,
    riskyCalls: Object.freeze(riskyCalls),
    analysisSource: "tree-sitter",
    analysisVersion: ANALYZER_VERSION,
  });
}

function isRiskyCall(callee: string): boolean {
  const lower = callee.toLowerCase();
  if (RISKY_TOKEN_SET.has(lower)) return true;
  // Member-access form (e.g. `child_process.exec`): each dotted
  // component is a chance to match. The chunker's `calleeText` already
  // strips to the rightmost segment, but a defensive split here covers
  // raw names that slip through.
  for (const part of lower.split(".")) {
    if (RISKY_TOKEN_SET.has(part)) return true;
  }
  return false;
}

interface WalkAcc {
  readonly imports: string[];
  readonly exports: string[];
  readonly calls: string[];
  nestingDepth: number;
  loopDepth: number;
  readonly record: (depth: number, kind: "nesting" | "loop") => void;
}

function walk(node: TreeSitterNode, profile: LanguageProfile, acc: WalkAcc): void {
  const isLoop = profile.loopNodes.has(node.type);
  const isNesting = profile.nestingNodes.has(node.type);
  if (isLoop) {
    acc.loopDepth += 1;
    acc.record(acc.loopDepth, "loop");
  }
  if (isNesting) {
    acc.nestingDepth += 1;
    acc.record(acc.nestingDepth, "nesting");
  }

  if (profile.importNodes.has(node.type)) {
    const target = importTargetText(node);
    if (target !== null) acc.imports.push(target);
  } else if (profile.exportNodes.has(node.type)) {
    // `export_statement` wraps the actual declaration; the name lives
    // on the inner function_declaration / class_declaration /
    // lexical_declaration node. Walk down to find it. Without this,
    // analyzer.exports was always empty for TS/JS chunks (#274).
    for (const name of exportedNames(node)) acc.exports.push(name);
  } else if (profile.callNodes.has(node.type)) {
    const callee = calleeText(node);
    if (callee !== null) acc.calls.push(callee);
  }

  for (const child of node.namedChildren) {
    walk(child, profile, acc);
  }

  if (isLoop) acc.loopDepth -= 1;
  if (isNesting) acc.nestingDepth -= 1;
}

/**
 * Pull every exported identifier out of an export_statement subtree.
 * Handles all the common shapes:
 *   - `export function foo() {}`              → ["foo"]
 *   - `export class Foo {}`                   → ["Foo"]
 *   - `export const x = …, y = …`             → ["x", "y"]
 *   - `export interface Foo {}`               → ["Foo"]
 *   - `export type Foo = …`                   → ["Foo"]
 *   - `export { Foo, Bar as Baz }`            → ["Foo", "Bar"]
 *   - `export default function foo() {}`      → ["foo"] (default name preserved)
 */
function exportedNames(node: TreeSitterNode): string[] {
  const out: string[] = [];
  // Try the wrapped declaration first.
  const decl = node.childForFieldName("declaration");
  if (decl !== null) {
    // Single named declaration (function, class, interface, type alias).
    const named = decl.childForFieldName("name");
    if (named !== null && named.text.length > 0) {
      out.push(named.text);
    }
    // Variable declarations have multiple declarators, each with its own name.
    if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
      for (const declarator of decl.namedChildren) {
        const dn = declarator.childForFieldName("name");
        if (dn !== null && dn.text.length > 0 && !out.includes(dn.text)) {
          out.push(dn.text);
        }
      }
    }
  }
  // `export { Foo, Bar as Baz }` — walk for export_specifier children.
  walkForExportSpecifiers(node, out);
  return out;
}

function walkForExportSpecifiers(node: TreeSitterNode, out: string[]): void {
  if (node.type === "export_specifier") {
    const named = node.childForFieldName("name");
    if (named !== null && named.text.length > 0 && !out.includes(named.text)) {
      out.push(named.text);
    }
    return;
  }
  for (const child of node.namedChildren) {
    walkForExportSpecifiers(child, out);
  }
}

function importTargetText(node: TreeSitterNode): string | null {
  // Try common field names across languages.
  for (const field of ["source", "module", "argument", "name"]) {
    const child = node.childForFieldName(field);
    if (child !== null && child.text.length > 0) return stripQuotes(child.text);
  }
  // Fall back to the first named string-like child.
  for (const child of node.namedChildren) {
    if (
      child.type === "string" ||
      child.type === "string_literal" ||
      child.type === "raw_string_literal"
    ) {
      return stripQuotes(child.text);
    }
  }
  return null;
}

function calleeText(node: TreeSitterNode): string | null {
  // Common shape: `call_expression -> function: identifier`
  const fn = node.childForFieldName("function") ?? node.childForFieldName("name");
  if (fn === null) return null;
  // For member-access (foo.bar()), keep the rightmost name.
  const text = fn.text;
  const dot = text.lastIndexOf(".");
  return dot === -1 ? text : text.slice(dot + 1);
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function dedupe(items: ReadonlyArray<string>): string[] {
  return [...new Set(items)];
}

/**
 * Walk the chunk subtree and collect every symbol reference worth
 * recording in the cross-reference graph (#96): the chunk's own
 * definition, every import target, and every callee. Variable
 * assignments and parameter names are excluded — they generate noise
 * without a real "find usages" payoff.
 *
 * Returns an empty array for languages without a profile so the indexer
 * can persist nothing without checking.
 */
export function extractSymbolRefs(
  node: TreeSitterNode,
  language: string,
): ReadonlyArray<SymbolRefExtract> {
  const profile = PROFILES[language];
  if (profile === undefined) return Object.freeze([]);

  const refs: SymbolRefExtract[] = [];

  // Definition: the chunk root's own name (if present). Wrappers like
  // `export_statement` (TS/JS) or `decorated_definition` (Python) don't
  // expose `name` directly — drill into the inner declaration so the def
  // row still lands. Single line — the wrapper's first line.
  const def = findDefName(node);
  if (def !== null) {
    refs.push({ symbol: def, kind: "def", line: node.startPosition.row + 1 });
  }

  walkRefs(node, profile, refs);

  // De-dupe (symbol, kind, line) — same call appearing twice on one line
  // is rare but possible and isn't useful as separate rows.
  return Object.freeze(dedupeRefs(refs));
}

/**
 * Find the chunk's primary symbol name. Tries `name` field first; falls
 * back to recursing into common wrapper nodes (`export_statement`,
 * `decorated_definition`) so wrapped declarations still produce a def
 * row.
 */
function findDefName(node: TreeSitterNode): string | null {
  const named = node.childForFieldName("name");
  if (named !== null && named.text.length > 0) return named.text;
  // Variable declarations carry their name on the inner variable_declarator
  // (e.g. `const X = ...` → lexical_declaration > variable_declarator >
  // name(X)). Without this, top-level `const`-shaped chunk roots produce
  // no symbol_refs def row and become invisible to find_usages.
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const declName = firstDeclaratorName(node);
    if (declName !== null) return declName;
  }
  const WRAPPER_TYPES = new Set([
    "export_statement",
    "decorated_definition",
    "async_function_definition",
  ]);
  if (!WRAPPER_TYPES.has(node.type)) return null;
  for (const child of node.namedChildren) {
    const inner = child.childForFieldName("name");
    if (inner !== null && inner.text.length > 0) return inner.text;
    // Wrapped variable declarations: `export const X = ...` → export_statement
    // > lexical_declaration > variable_declarator > name(X). Drill one more
    // level when the wrapped child has no own name field.
    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      const declName = firstDeclaratorName(child);
      if (declName !== null) return declName;
    }
  }
  return null;
}

function firstDeclaratorName(decl: TreeSitterNode): string | null {
  for (const child of decl.namedChildren) {
    if (child.type !== "variable_declarator") continue;
    const name = child.childForFieldName("name");
    if (name !== null && name.text.length > 0) return name.text;
  }
  return null;
}

function walkRefs(
  node: TreeSitterNode,
  profile: LanguageProfile,
  out: SymbolRefExtract[],
  depth = 0,
): void {
  if (profile.importNodes.has(node.type)) {
    const target = importTargetText(node);
    if (target !== null && target !== "") {
      out.push({ symbol: target, kind: "import", line: node.startPosition.row + 1 });
    }
  } else if (profile.callNodes.has(node.type)) {
    const callee = calleeText(node);
    if (callee !== null && callee !== "") {
      out.push({ symbol: callee, kind: "call", line: node.startPosition.row + 1 });
    }
  }
  // Class-member / impl-block methods (#278): findDefName already
  // covered the chunk root's primary symbol. depth>0 ensures we don't
  // double-emit a def for the root itself when it's a function-shaped
  // node that also appears in methodDefNodes (Python, Rust).
  if (depth > 0 && profile.methodDefNodes.has(node.type)) {
    const name = node.childForFieldName("name")?.text;
    if (name !== undefined && name.length > 0) {
      out.push({ symbol: name, kind: "def", line: node.startPosition.row + 1 });
    }
  }
  for (const child of node.namedChildren) {
    walkRefs(child, profile, out, depth + 1);
  }
}

function dedupeRefs(refs: ReadonlyArray<SymbolRefExtract>): SymbolRefExtract[] {
  const seen = new Set<string>();
  const out: SymbolRefExtract[] = [];
  for (const r of refs) {
    const key = `${r.symbol}${r.kind}${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
