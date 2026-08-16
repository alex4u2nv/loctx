// Copy non-TS resources (SQL, bundled ast-grep rules) from src/ to dist/
// alongside the compiled JS so sibling lookups via `import.meta.url` work
// at runtime.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/sql", { recursive: true });
cpSync("src/sql", "dist/sql", { recursive: true, filter: (s) => !s.endsWith(".ts") });

mkdirSync("dist/rules", { recursive: true });
cpSync("src/rules", "dist/rules", { recursive: true, filter: (s) => !s.endsWith(".ts") });

mkdirSync("dist/agent-setup/skills", { recursive: true });
cpSync("src/agent-setup/skills", "dist/agent-setup/skills", { recursive: true });

console.log("copied SQL, rule, and skill assets to dist/");
