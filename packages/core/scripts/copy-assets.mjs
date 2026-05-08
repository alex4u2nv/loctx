// Copy non-TS resources (SQL) from src/ to dist/ alongside the compiled JS
// so sibling lookups via `import.meta.url` work at runtime.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/sql", { recursive: true });
cpSync("src/sql", "dist/sql", { recursive: true, filter: (s) => !s.endsWith(".ts") });
console.log("copied SQL assets to dist/");
