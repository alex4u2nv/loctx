/**
 * Lazy-loaded syntax highlighter. Shiki ships TextMate grammars + VS
 * Code themes, which is overkill for what we need most of the time —
 * but the import is dynamic so the cost only lands on tabs that
 * actually open a code-preview modal. The initial dashboard bundle is
 * not affected (see #256).
 *
 * Singleton highlighter caches across modal opens. Languages register
 * lazily on first use.
 */

import type { BundledLanguage, BundledTheme, Highlighter } from "shiki";

/** Languages we eagerly load on first use — the set loctx commonly indexes. */
const PRIMARY_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "markdown",
  "json",
  "yaml",
  "sql",
  "css",
  "html",
  "bash",
  "shell",
] as const;

// Dual-theme output: Shiki emits each token with both `--shiki-light` and
// `--shiki-dark` CSS variables and `defaultColor: false` so no colour is
// baked in. styles.css then picks light or dark per active app theme — so
// a code preview follows the chosen theme (no more jarring light island on
// the dark themes) with zero re-highlighting on switch.
const LIGHT_THEME: BundledTheme = "github-light";
const DARK_THEME: BundledTheme = "github-dark";

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>(PRIMARY_LANGS);

async function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    // Dynamic import keeps shiki out of the initial bundle. Vite produces
    // a separate chunk loaded on the first modal open.
    highlighterPromise = import("shiki").then((m) =>
      m.createHighlighter({
        themes: [LIGHT_THEME, DARK_THEME],
        langs: PRIMARY_LANGS as unknown as BundledLanguage[],
      }),
    );
  }
  return highlighterPromise;
}

/**
 * Highlight `code` for `language`. Returns Shiki-rendered HTML, or
 * null when the language isn't supported and we should fall back to
 * plain text. Never throws — unknown language errors resolve to null.
 */
export async function highlightCode(code: string, language: string | null): Promise<string | null> {
  const lang = normalizeLanguage(language);
  if (lang === null) return null;
  try {
    const h = await getHighlighter();
    if (!loadedLangs.has(lang)) {
      // Late-bind a language we didn't preload (e.g. "tsx" when the
      // singleton was created without it). Cache to skip the load on
      // subsequent calls.
      await h.loadLanguage(lang as BundledLanguage);
      loadedLangs.add(lang);
    }
    return h.codeToHtml(code, {
      lang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
    });
  } catch {
    // Unknown language, network failure on grammar fetch (Shiki bundles
    // them, but a custom shiki build could miss one) — degrade to plain.
    return null;
  }
}

/**
 * Map file extensions + free-form language names emitted by the
 * searcher to Shiki's bundled language identifiers. Returns null when
 * we have nothing reasonable to map to.
 */
function normalizeLanguage(raw: string | null): string | null {
  if (raw === null) return null;
  const lower = raw.toLowerCase().trim();
  if (lower === "") return null;
  // SearchHit.language can already be a Shiki-compatible name; try it
  // straight first, then fall back to the alias map.
  if (KNOWN_LANGS.has(lower)) return lower;
  return ALIAS[lower] ?? null;
}

/** Languages we know Shiki accepts directly. */
const KNOWN_LANGS = new Set<string>([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "markdown",
  "json",
  "yaml",
  "sql",
  "css",
  "html",
  "bash",
  "shell",
]);

/** Common aliases / extensions → Shiki language id. */
const ALIAS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  md: "markdown",
  yml: "yaml",
  sh: "bash",
  zsh: "bash",
  // path-extension keys (dotted) that the caller might pass straight
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".md": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sql": "sql",
  ".css": "css",
  ".html": "html",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
};

/**
 * Convenience for callers that only have a file path: infer the
 * language from the trailing extension. Returns null on no match.
 */
export function languageFromPath(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return null;
  return ALIAS[path.slice(dot).toLowerCase()] ?? null;
}
