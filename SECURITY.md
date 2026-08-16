# Security

## Reporting

**Do not file public GitHub issues for vulnerabilities.**

Use GitHub's private vulnerability reporting: the **Security** tab of
this repository → **Report a vulnerability**. Include:

- A description and impact.
- Steps to reproduce, or a minimal proof of concept.
- Version (`loctx --version`), OS, Node version.

Acknowledgement within 7 days. Disclosure timeline scales with severity. Credit in the [CHANGELOG](CHANGELOG.md) entry unless you prefer otherwise.

## Supported versions

Until 1.0, only the latest minor on `main` receives fixes.

## Threat model

loctx binds to `localhost`. Anyone with shell access on the host can read what the daemon can. Multi-user host security falls to standard filesystem permissions, not loctx.

In scope:

- Code injection via crafted file content, filenames, config values.
- Path traversal via malicious project roots or rule files.
- SQL injection in any query reaching SQLite.
- Bypass of the secret-glob filter (see [docs/PRIVACY.md](docs/PRIVACY.md) for the baseline and the negation invariant).
- Outbound network calls outside the documented surface.

Out of scope:

- Network exposure when binding to non-loopback addresses. That is the user's call. Add your own auth layer.
- Embedding model integrity. Verify model provenance through Hugging Face.

## Privacy

[docs/PRIVACY.md](docs/PRIVACY.md) covers what data the tool reads, where it stores it, and the one network surface it touches.
