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

import type { AnalyzerMetadata } from "../models.js";

export const ANALYZER_VERSION = 1;

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

  return Object.freeze({
    imports: Object.freeze(dedupe(imports)),
    exports: Object.freeze(dedupe(exports)),
    calls: Object.freeze(dedupe(calls)),
    maxNestingDepth,
    maxLoopDepth,
    paramCount,
    hasAsync,
    hasRecursionHint: false,
    riskyCalls: Object.freeze([]),
    analysisSource: "tree-sitter",
    analysisVersion: ANALYZER_VERSION,
  });
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
    const exportName = node.childForFieldName("name")?.text;
    if (exportName !== undefined) acc.exports.push(exportName);
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
