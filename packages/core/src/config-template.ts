/**
 * The commented YAML template `loctx config init` writes (#542 split
 * from config.ts). Every key mirrors a built-in default from
 * config.ts — keep the two in sync.
 */

/**
 * Commented YAML template written by `loctx config init`. Every key is the
 * built-in default, surfaced so users can edit rather than discover.
 */
export const CONFIG_TEMPLATE = `# loctx global config — $XDG_CONFIG_HOME/loctx/config.yaml
# Edit here or via the admin UI; this is the single source of truth.

# Roots searched for projects (each top-level dir with a .git/ becomes a project).
# Defaults to process.cwd() when omitted.
# workspace_roots:
#   - ~/Workspaces

embedding:
  provider: huggingface-transformers
  model: Xenova/all-MiniLM-L6-v2
  normalize: true

watcher:
  debounce_ms: 500

daemon:
  port: 3022
  # 127.0.0.1 (literal loopback IP) blocks browser DNS-rebinding attacks.
  # Use \`localhost\` only if you understand and accept that trade-off.
  hostname: 127.0.0.1

retrieval:
  # hybrid (default) | vector | lexical
  mode: hybrid
  # Reciprocal rank fusion constant; 60 is the literature default.
  rrf_k: 60

# Background index maintenance. The vector store is append-only, so a
# long-lived daemon accumulates dead version history; loctx compacts it
# automatically on this cadence (and you can trigger it from the admin
# "Index → compact" button anytime). Set to 0 to disable auto-compaction.
maintenance:
  compact_interval_hours: 24

# Background code-analysis queue (runs out of band from indexing/search).
# All analyzers are ON by default. duplicates is pure-JS and works as-is.
# lizard/semgrep/astGrep shell out to external binaries — they stay enabled
# but the indexer skips them automatically until the command is installed
# (and, for the rule-pack scanners, until you point them at rule_dirs).
analyzers:
  background_enabled: true
  duplicates:
    enabled: true
  lizard:
    enabled: true
    # command: lizard          # pip install lizard
  semgrep:
    enabled: true
    # command: semgrep
    # rule_dirs: [~/rules/semgrep]
  astGrep:
    enabled: true
    # command: ast-grep
    # rule_dirs: [~/rules/ast-grep]
  # Heuristic quality rules (god-file, long-params, deep-nesting,
  # fan-in/out) computed from data the index already holds. Pure JS.
  quality:
    enabled: true
    # god_file_nloc: 400
    # max_params: 5

mcp:
  # Rolling row cap on the MCP request log (the admin "logs" page).
  # Oldest rows are trimmed past this count. Set to 0 to disable logging.
  log_max_rows: 200
  # Expose the admin_workspace MCP tool so a connected LLM can run
  # maintenance (compact, analyzer backfill) and read/write this config.
  # Privileged — leave false unless you trust whatever's on the MCP channel.
  admin_enabled: false

# Outbound network — set these only behind a TLS-intercepting proxy or
# corporate firewall (e.g. Socket Firewall). They apply to the embedding
# model download and to loctx's own updates / tool installs.
network:
  # Path to a root CA cert PEM to trust (your org's / proxy's CA). On macOS
  # you can export the keychain: security find-certificate -a -p \\
  #   /Library/Keychains/System.keychain \\
  #   /System/Library/Keychains/SystemRootCertificates.keychain > ca.pem
  # ca_cert: ~/.config/loctx/ca.pem
  # HTTP(S) proxy URL, if your network requires one.
  # proxy: http://proxy.corp:8080
  # Last resort — disables TLS verification entirely. Prefer ca_cert.
  strict_ssl: true
`;
