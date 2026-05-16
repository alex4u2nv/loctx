/**
 * Canonical filtering defaults.
 *
 * Inlined as a TypeScript constant rather than loaded from a YAML file at
 * runtime. Reading a sibling YAML via `new URL("./data/filtering.yaml",
 * import.meta.url)` breaks under webpack-bundled environments (Next.js)
 * because webpack rewrites the URL into a polyfilled instance that fails
 * Node's `fileURLToPath` instanceof check.
 *
 * Edit this file directly when adding/removing baseline ignore rules. The
 * old `src/data/filtering.yaml` was retired in M7#34 — this constant is the
 * single source of truth.
 *
 * User overrides continue to load from `~/.loctx/config_overrides/*.{yaml,yml}`
 * at runtime.
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
    // env files
    ".env",
    ".env.*",
    // x.509 + ssh keys
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    // password stores
    "*.kdbx",
    "credentials.json",
    "secrets.json",
    // cloud + registry credentials (basename matched by ProjectFilter)
    "credentials",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".pgpass",
    // common token / config drop-ins
    "token",
    "gh-token",
    "gitea-token",
    "gitlab-token",
    "auth.json",
    "service-account*.json",
    "*-credentials.json",
    "*.kubeconfig",
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
