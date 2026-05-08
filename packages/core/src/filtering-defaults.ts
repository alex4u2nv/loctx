/**
 * Bundled filtering defaults.
 *
 * Inlined as a TypeScript constant rather than loaded from a YAML file at
 * runtime. Reading a sibling YAML via `new URL("./data/filtering.yaml",
 * import.meta.url)` breaks under webpack-bundled environments (Next.js)
 * because webpack rewrites the URL into a polyfilled instance that fails
 * Node's `fileURLToPath` instanceof check.
 *
 * Authoring still happens in YAML — see `scripts/sync-filtering-defaults.mjs`
 * for regenerating this file from `src/data/filtering.yaml` when the
 * defaults change.
 *
 * User overrides continue to load from `~/.loctx/config_overrides/*.{yaml,yml}`
 * at runtime (those files don't exist at build time so webpack can't bundle
 * them anyway).
 */

export const FILTERING_DEFAULTS = {
  max_file_size_bytes: 1_048_576,
  follow_symlinks: false,
  ignored_dirs: [
    // vcs
    ".git",
    ".hg",
    ".svn",
    // python
    "__pycache__",
    ".venv",
    "venv",
    "env",
    "ENV",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".pytype",
    // node / js
    "node_modules",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
    ".yarn",
    ".pnp",
    // build outputs
    "dist",
    "build",
    "out",
    "target",
    ".gradle",
    ".mvn",
    // coverage / test outputs
    "coverage",
    ".nyc_output",
    "htmlcov",
    // editors / ides
    ".idea",
    ".vscode",
    ".vs",
    // caches
    ".cache",
    ".sass-cache",
    // ai tooling state
    ".claude",
    ".cursor",
    ".aider",
  ],
  secret_globs: [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "*.p12",
    "*.pfx",
    "credentials.json",
    "secrets.json",
    "*.kdbx",
  ],
  secret_allowlist_globs: [".env.example", ".env.template", ".env.sample", ".env.dist"],
  allowed_extensions: [
    // python
    ".py",
    ".pyi",
    ".ipynb",
    // javascript / typescript
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".vue",
    ".svelte",
    // jvm
    ".java",
    ".kt",
    ".kts",
    ".scala",
    ".groovy",
    // native
    ".c",
    ".h",
    ".cpp",
    ".cc",
    ".cxx",
    ".hpp",
    ".hh",
    ".m",
    ".mm",
    ".rs",
    ".go",
    ".swift",
    ".zig",
    // other languages
    ".rb",
    ".php",
    ".pl",
    ".lua",
    ".ex",
    ".exs",
    ".erl",
    ".clj",
    ".cljs",
    ".cs",
    ".fs",
    ".dart",
    ".r",
    ".jl",
    // shell / scripts
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".ps1",
    // config / data / markup
    ".json",
    ".jsonc",
    ".toml",
    ".yaml",
    ".yml",
    ".ini",
    ".cfg",
    ".conf",
    ".xml",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    // infra / iac
    ".tf",
    ".tfvars",
    ".hcl",
    ".bicep",
    ".dockerfile",
    // query / schema
    ".sql",
    ".graphql",
    ".gql",
    ".proto",
    ".prisma",
    // docs
    ".md",
    ".mdx",
    ".rst",
    ".adoc",
    ".txt",
  ],
  allowed_named_files: [
    "Dockerfile",
    "Containerfile",
    "Makefile",
    "GNUmakefile",
    "Rakefile",
    "Gemfile",
    "Procfile",
    "Vagrantfile",
    "Brewfile",
    "Justfile",
    "CMakeLists.txt",
    "BUILD",
    "WORKSPACE",
    "Cargo.toml",
    "go.mod",
    "go.sum",
    "package.json",
    "pyproject.toml",
    "uv.lock",
    "poetry.lock",
    "Pipfile",
    "Pipfile.lock",
    "requirements.txt",
    "tsconfig.json",
    "README",
    "LICENSE",
    "NOTICE",
    "CHANGELOG",
  ],
} as const;
