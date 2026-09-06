# Local testing during the TypeScript migration

Verified on 2026-09-06 against staging commit
`2ca9d6e2c47948df57e7649a2211d4ec523bb364` and the live staging ruleset:
automatic **Validate Plugin** runs and required status checks are disabled for
staging. Manual dispatch remains available. Main validation and nightly tests
remain enabled. **Release Validation still runs on staging pushes and includes
Python package checks**; run `34035182132` passed for that staging commit.
This is a limited staging exception, not a freeze of every Python CI job.
This change does not modify workflows or branch protection.

## Tiered checks

| Trigger | Checks | Escalation |
| --- | --- | --- |
| Commit | Whitespace, all six fast matrix suites, TypeScript, source size, emitted-runtime parity, local Markdown file links | Failures block the commit; no browser/package suite starts |
| Push, known narrow change | Commit-level checks plus explicitly mapped focused contracts | Unknown paths, deleted focused modules, broad tooling/dependency changes and tags require deep evidence |
| Deep validation | Fast checks plus all affected heavier suites; global/unknown changes and tags include full, release and native-platform suites | Explicit command, run once per outgoing commit/base/environment; successful local evidence can be reused for 24 hours |
| Migration wave / production cutover | Integrated behavior, browser, packaging, applicable native hosts, supported Python reference version and rollback gates from the migration plan | Local hooks cannot substitute for missing platform/reference evidence; restore staging CI before cutover |

Fast checks include a small Python contract/policy suite while Python remains the
behavioral reference. Each quick suite has a two-minute ceiling, with at most two
suites running together. Deep checks run one suite at a time, with a default
15-minute ceiling per suite. These are upper bounds, not expected durations.
Timeouts, interruptions, missing executables, missing selected tests and excessive
output fail verification. Owned subprocess groups and temporary checkouts are
cleaned up. Neither tier installs dependencies or changes a live Store.

The initial focused mappings reserve paths for the migration branch's inert numeric
codec, raw matching reference vectors and profile-fact reference vectors. Selecting
a mapping whose tests have not landed fails closed. New production modules must acquire
reviewed ownership and tests before getting a narrower path rule. Existing matrix
ownership selects other affected suites. Unknown paths escalate conservatively.
Documentation-only pushes avoid full tests but still check local file links.
External URLs and Markdown anchors remain the responsibility of broader checks.

## Installation and use

Run once in each working checkout:

```sh
npm ci
npm run hooks:install
```

Native Git hooks provide the required commit/push behavior without adding Husky
as a dependency. Installation sets an absolute `core.hooksPath` for this worktree
only and refuses to disable existing custom hooks. Installation is explicit;
dependency installation does not silently reconfigure Git.

```sh
npm run verify:commit
npm run verify:push
npm run verify:deep -- --head HEAD --base origin/staging
```

`verify:commit` checks the exact staged index in a disposable checkout, preserving
unstaged edits and the original index. It refuses success if the index changes
during validation. Commit checks therefore require all needed files to be staged.

`verify:push` checks committed changes, defaulting to HEAD and its merge base with
`origin/staging`. The installed pre-push hook instead reads Git's actual outgoing
ref updates: every pushed commit is checked, even when it is not HEAD. Existing
remote object IDs provide the comparison base. New branches use a merge base with
the configured comparison ref. Missing objects or comparison refs fail with no
fallback. Fetch the relevant refs before retrying. Deletion-only pushes have no
new code to test; annotated tags are peeled and require release checks.

For broader changes, the hook prints the exact deep command with immutable commit
and base IDs. Run that printed command after committing, then retry the push.
Use `--release` when validating a tag. A deep command with a different comparison
base will not satisfy the hook. An alternate comparison branch can be configured
with `git config --worktree localChecks.baseRef REF` after hook installation.

## Evidence and limitations

Receipts and bounded logs live in the worktree's Git metadata under `local-checks`.
They bind the outgoing commit/tree, comparison base, tag mode, suite definitions,
active hook and runner implementation, Node/Python versions, operating system,
architecture, dependency lock and installed dependency metadata. A changed identity,
failed run, incomplete result set or expired receipt cannot satisfy escalation.
Only successful **deep** receipts satisfy a broader push requirement.

Snapshots reuse the checkout's installed dependencies only when the target lock
matches. Install dependencies after lock changes. Hooks do not certify arbitrary
manual changes inside `node_modules`; dependency metadata is not a security proof.
Treat a cached receipt as local test evidence, not a signed attestation.

Foreign-platform suites are explicitly recorded as deferred, never claimed passed.
The hooks have local macOS validation; native Windows execution remains unverified.
Python reference tests may also report version-specific skips inside suite output;
retain those logs and keep the corresponding migration acceptance cells open.
Local success is not full cross-platform or full migration acceptance.

Git hooks are bypassable and are not server-side enforcement; see
[Git hook documentation](https://git-scm.com/docs/githooks).
Do not use bypasses to describe failed or missing evidence as passing.

## Parallel worker protocol

The coordinator assigns disjoint `allowed_files` and a focused test command to
each worker. Each worker runs focused tests after its last meaningful edit and
returns the tested commit, results, skips and limitations. Commit hooks provide
the common fast gate. The coordinator integrates a wave, resolves ownership
conflicts and runs affected/deep validation once on the integrated outgoing commit.
Any subsequent edits invalidate that evidence. Do not have every worker rerun
browser/package suites for the same unchanged integration state.

Keep one Store facade owner and one workspace bootstrap owner at a time. Python
and TypeScript writers must never mutate the same live Store. The
[migration plan](superpowers/plans/2026-09-04-typescript-strangler-migration.md) and
[modernization checkpoint](modernization-checkpoint.md) retain the full acceptance gates,
including human-only final submission and restoration of staging CI.
