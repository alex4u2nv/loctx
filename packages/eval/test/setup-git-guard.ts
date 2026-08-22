/**
 * #513 guard: poison the repo-targeting git env vars for every eval
 * test, so an unpinned or unscrubbed `git` shell-out fails loudly
 * ("not a git repository: /nonexistent/…") instead of silently
 * operating on the developer's real checkout — which is exactly how a
 * fixture commit once landed on a working branch. Tests and code that
 * legitimately shell git must pin `-C <tmpdir>` AND scrub these vars
 * from the child env (see corpus-resolve.test.ts / corpus.ts gitEnv).
 */
const POISON = "/nonexistent/loctx-test-git-guard";
process.env["GIT_DIR"] = POISON;
process.env["GIT_WORK_TREE"] = POISON;
delete process.env["GIT_INDEX_FILE"];
