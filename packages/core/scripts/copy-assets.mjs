// Copy non-TS resources (SQL, YAML) from src/ to dist/ alongside the
// compiled JS so importlib-style sibling lookups work at runtime.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/sql", { recursive: true });
mkdirSync("dist/data", { recursive: true });
cpSync("src/sql", "dist/sql", { recursive: true, filter: (s) => !s.endsWith(".ts") });
cpSync("src/data", "dist/data", { recursive: true });
console.log("copied SQL + YAML assets to dist/");
