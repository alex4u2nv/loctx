/**
 * Generated fixture workspace for retrieval evaluation.
 *
 * Three fake projects on a temp directory, each populated with code,
 * markdown docs, skills, and config files that exercise the retrieval
 * categories called out in issue #10:
 *
 *   - exact symbol / function / class
 *   - filename / path
 *   - code fragment
 *   - markdown heading
 *   - command mention / config key
 *   - terminology drift (same concept, different words)
 *   - refactor coverage (prose + code)
 *
 * Generated at test time so the fixtures stay deterministic in CI; no
 * network, no shared mutable state on disk.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FixtureFile {
  /** Path relative to the project root. */
  readonly relPath: string;
  readonly content: string;
}

export interface FixtureProject {
  readonly name: string;
  readonly files: ReadonlyArray<FixtureFile>;
}

/**
 * Three projects:
 *   - alpha  : a small auth-aware HTTP service (TypeScript)
 *   - beta   : a data-pipeline CLI (Python)
 *   - gamma  : a skills/process knowledge-base (Markdown)
 *
 * Tokens overlap deliberately across projects so terminology-drift
 * queries can be tested ("auth" in alpha vs "credential check" in
 * beta; "rate limit" in alpha vs "throttle" in beta).
 */
export const FIXTURE_PROJECTS: ReadonlyArray<FixtureProject> = Object.freeze([
  {
    name: "alpha",
    files: Object.freeze([
      {
        relPath: "src/auth/login.ts",
        content: `export async function authenticateUser(token: string): Promise<Session> {
  const claims = await verifyJwt(token);
  if (claims.expired) throw new Error("session expired");
  return { userId: claims.sub, role: claims.role };
}

export interface Session {
  readonly userId: string;
  readonly role: string;
}
`,
      },
      {
        relPath: "src/auth/jwt.ts",
        content: `export async function verifyJwt(token: string): Promise<Claims> {
  // Real impl would call out to the JWKS endpoint.
  if (!token) throw new Error("missing bearer token");
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64").toString());
}

export interface Claims {
  readonly sub: string;
  readonly role: string;
  readonly expired: boolean;
}
`,
      },
      {
        relPath: "src/middleware/rate-limiter.ts",
        content: `export function rateLimit(opts: { perMinute: number }): Middleware {
  const counts = new Map<string, number>();
  return async (req, next) => {
    const key = req.ip;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > opts.perMinute) throw new Error("rate limit exceeded");
    return next(req);
  };
}

type Middleware = (req: { ip: string }, next: (r: unknown) => unknown) => Promise<unknown>;
`,
      },
      {
        relPath: "src/config/loader.ts",
        content: `export function loadServiceConfig(path: string): ServiceConfig {
  const raw = parseToml(readFileSync(path, "utf-8"));
  return {
    port: raw["port"] as number,
    databaseUrl: raw["database_url"] as string,
    rateLimit: raw["rate_limit_per_minute"] as number,
  };
}

export interface ServiceConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly rateLimit: number;
}

declare function parseToml(text: string): Record<string, unknown>;
declare function readFileSync(path: string, enc: string): string;
`,
      },
      {
        relPath: "README.md",
        content: `# Alpha Service

HTTP API for user-facing flows. Uses JWT for authentication and an in-memory rate limiter to bound abuse.

## Configuration

Config lives in \`config.toml\`. Required keys: \`port\`, \`database_url\`, \`rate_limit_per_minute\`.

## Running

\`\`\`bash
npm run start -- --config /etc/alpha/config.toml
\`\`\`

## Endpoints

- \`POST /login\` — authenticate with bearer token, returns a session.
- \`GET /health\` — liveness probe.
`,
      },
      {
        relPath: "config.toml",
        content: `port = 8080
database_url = "postgres://localhost/alpha"
rate_limit_per_minute = 60
`,
      },
    ]),
  },
  {
    name: "beta",
    files: Object.freeze([
      {
        relPath: "pipeline/credential_check.py",
        content: `def credential_check(headers: dict) -> bool:
    """Verify the request carries a valid bearer credential.

    Equivalent to authenticateUser in alpha but for the data ingest path.
    """
    token = headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise ValueError("missing credential")
    return token == EXPECTED_TOKEN


EXPECTED_TOKEN = "ingest-prod-2026"
`,
      },
      {
        relPath: "pipeline/throttle.py",
        content: `class RequestThrottle:
    """In-memory token bucket throttle. Throttles requests by source key.

    Equivalent to alpha's rateLimit middleware in TypeScript.
    """

    def __init__(self, per_second: int) -> None:
        self.per_second = per_second
        self.window: dict[str, int] = {}

    def admit(self, key: str) -> bool:
        # Increment the throttle counter for this source.
        seen = self.window.get(key, 0)
        self.window[key] = seen + 1
        return seen < self.per_second
`,
      },
      {
        relPath: "pipeline/ingest.py",
        content: `from .credential_check import credential_check
from .throttle import RequestThrottle


def ingest(record: dict, headers: dict, throttle: RequestThrottle) -> None:
    if not credential_check(headers):
        raise PermissionError("credential rejected")
    if not throttle.admit(record["source"]):
        raise OverflowError("source over throttle")
    write_record(record)


def write_record(record: dict) -> None:
    print(record)
`,
      },
      {
        relPath: "pipeline/config.py",
        content: `from dataclasses import dataclass


@dataclass(frozen=True)
class IngestConfig:
    """Loader equivalent to alpha's loadServiceConfig."""

    db_url: str
    throttle_per_second: int
    expected_token: str


def load_ingest_config(path: str) -> IngestConfig:
    import tomllib
    raw = tomllib.loads(open(path).read())
    return IngestConfig(
        db_url=raw["db_url"],
        throttle_per_second=raw["throttle_per_second"],
        expected_token=raw["expected_token"],
    )
`,
      },
      {
        relPath: "docs/architecture.md",
        content: `# Beta Pipeline

Beta consumes records from upstream and writes them to the warehouse. Two safety layers run on every request:

## Credential check

The \`credential_check\` function reads the \`Authorization\` header and compares to a fixed token. This is the analogue of alpha's \`authenticateUser\`.

## Throttle

The \`RequestThrottle\` class limits requests per source key. This is the analogue of alpha's rate limiter.

## Refactor history

This pipeline used to share helpers with alpha; the auth + rate limit logic was forked when the data platform team took ownership. Both implementations now drift independently.
`,
      },
    ]),
  },
  {
    name: "gamma",
    files: Object.freeze([
      {
        relPath: "skills/writing-style/SKILL.md",
        content: `---
name: writing-style
description: House writing style for prose. Active voice, no clichés.
---

# Writing Style

Apply to all prose: emails, docs, page copy, marketing.

## Active voice

Use active voice. \`The build server runs the tests\`, not \`the tests are run by the build server\`.

## No em dashes

Don't use em dashes. Use commas, periods, parentheses, or rewrite.

## Vary sentence length

Mix short and long sentences. Two sentences in a row at 30 words each is monotony.
`,
      },
      {
        relPath: "skills/code-style/SKILL.md",
        content: `---
name: code-style
description: Functional, modern code style across Python and TypeScript.
---

# Code Style

## TypeScript

- \`const\` over \`let\`. Never \`var\`.
- Arrow functions over function declarations.
- \`.map()\` / \`.filter()\` / \`.reduce()\` over \`for\` loops.
- Optional chaining (\`?.\`) and nullish coalescing (\`??\`).

## Python

- Use \`pathlib.Path\` over \`os.path\` strings.
- List/dict comprehensions over imperative append loops.
- \`match\` / \`case\` over chained if/elif.
`,
      },
      {
        relPath: "processes/onboarding.md",
        content: `# Onboarding a new client

When a new client signs the agreement, run through these steps in order.

## 1. Create the workspace

Provision a Postgres database, an S3 bucket, and a SOC2-tagged Slack channel. Naming convention: \`client-<slug>\`.

## 2. Issue API credentials

Generate a bearer token via \`scripts/issue-credential.sh\`. Store the token in 1Password under \`Client Credentials\`. Send the credential to the client via signed email.

## 3. Configure rate limits

Default rate limit is 60 requests per minute per token. Adjust per the contract.

## 4. Run the smoke test

Execute \`npm run smoke -- --client <slug>\`. The smoke test issues a known request and verifies the warehouse received the record.
`,
      },
      {
        relPath: "processes/incident-response.md",
        content: `# Incident response

When an alarm fires, follow this runbook.

## Step 1: Acknowledge

Click \`Acknowledge\` in PagerDuty within 5 minutes. Post in \`#incidents\`.

## Step 2: Determine scope

Check the dashboards. If only one client is affected, tag the incident as \`scoped\`. If multiple, tag as \`platform\`.

## Step 3: Mitigate

Common mitigations: roll back the last deploy, increase rate limits, drain the queue. Document the mitigation in the incident channel.

## Step 4: Postmortem

Within 48 hours, post a written postmortem in \`docs/incidents/\`.
`,
      },
      {
        relPath: "processes/release.md",
        content: `# Release process

Cut a release every Friday at 16:00.

## Pre-flight checklist

- [ ] CI green on \`main\`
- [ ] No open security issues tagged \`release-blocker\`
- [ ] Changelog updated

## Cutting the release

Run \`scripts/release.sh <version>\`. The script tags the commit, builds the artifacts, and posts to the release channel.

## Post-release

Monitor the dashboards for 30 minutes. If error rates exceed 1%, run \`scripts/release-rollback.sh\`.
`,
      },
    ]),
  },
]);

/**
 * Materialize all fixture projects on disk under `root`. Returns the absolute
 * project roots in declaration order so callers can pass them as
 * `workspace_roots`.
 */
export function writeFixtureWorkspace(root: string): ReadonlyArray<string> {
  const projectRoots: string[] = [];
  for (const project of FIXTURE_PROJECTS) {
    const projectRoot = join(root, project.name);
    mkdirSync(projectRoot, { recursive: true });
    // Mark each as a git project so discovery picks them up.
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");

    for (const file of project.files) {
      const target = join(projectRoot, file.relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf-8");
    }
    projectRoots.push(projectRoot);
  }
  return Object.freeze(projectRoots);
}
