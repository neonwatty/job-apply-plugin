# TypeScript Agent Workflows readiness

Date: 2026-09-17

## Scope

This is the installation, candidate-manifest, readiness, and fresh-agent
handoff slice only. It creates no Agent Workflows run, Training evidence,
browser evidence, production application, employer-site action, or final action.
It does not initialize an isolated Job Apply Store and does not read, clone, or
mutate the canonical Store.

## Reproducible installation

The consumer installs the private package from its clean immutable Git commit,
not from the locally modified Workflows checkout and not from the public npm
registry:

- package: `@lineagehq/workflows`
- package version: `0.1.0`
- protocol version: `1.0`
- tag: `v0.1.0`
- peeled tag commit: `5268fa8f287c3b64f55f0c4438815b800f69d778`
- dependency source: `github:lineagehq/workflows#5268fa8f287c3b64f55f0c4438815b800f69d778`
- installed package integrity: `sha512-4cizzFvck9CWs73P9XKA7sbdUXEmQ1Z+Ck8FndXhTVwVsE7IlCBGTWClRgQa5kO4BPimAcpnFnf6v6QsxDM7mw==`
- CLI: `node_modules/.bin/workflow`
- minimum Node version declared by the package: `22.13.0`

The public npm registry has no `@lineagehq/workflows@0.1.0` release. The exact
Git commit is therefore the distribution identity and reproducibility anchor;
the generated lockfile additionally records the installed package integrity.

The supported `workflow init --host codex` path generated exactly the pinned
Codex skill, its OpenAI metadata, and protocol reference under
`.agents/skills/agent-workflows/`. A second initializer invocation reported all
three files as unchanged.

## Candidate lifecycle

The project config uses a fixed IPv4 loopback port and a repository-local,
ignored run/Store root. Before a future run, the operator must build Companion,
create `.workflows/local` with owner-only permissions, and start Companion with
the declared command. Companion emits a fresh authenticated URL. The browser
host must use that complete URL; the static base URL alone is deliberately not
treated as authenticated readiness.

The single candidate lifecycle is value-bounded to the committed fictional TXT
fixture. It imports that resume, requests extraction once, and inspects the
proposal-review boundary. It stops with the request queued because the browser
cannot author a Job Apply extraction proposal. A later phase may add a separate
runner-controlled seam for agent-authored proposal completion, but this slice
does not invent one or claim review completion.

Both desktop and mobile browser resolutions are declared. No replay is
authorized until the fresh-agent gate below passes.

## Validation

- `npm ci` reproduced the exact Git dependency and reported zero vulnerabilities.
- `workflow doctor --json` passed with package `0.1.0`, Node `v22.22.3`, and all six expected schema kinds.
- `workflow validate` accepted the project config and candidate workflow.
- `workflow show` resolved five steps for both desktop and mobile; their exact source and effective hashes are in the receipt.
- JSON parsing, `git diff --check`, initializer idempotency, and the assertion that `.workflows/local` remains absent all passed.
- The repository affected gate selected 25 suites because the lockfile is a global path. Product, typecheck, source-size, matrix, migration-evidence, browser, and workspace suites passed; the workspace suite passed 1,871 tests (1,897 assertions, 26 intentional skips).
- The aggregate affected gate remained red for two pre-existing host/policy conditions unrelated to these declarative Workflows files: the migration inventory refuses an intentionally dirty pre-commit snapshot, and the native POSIX-lock host qualification rejects the current Python alias/executable identity. The focused rerun reproduced `Python alias and resolved executable disagree`; versioned Python 3.12, 3.13, and 3.14 lock-ordering profiles passed. No frozen host evidence was changed.
- The exact `package.json` hash and its review-lock binding were reconciled after commit. The final clean migration audit reports `inventory-consistent` with no errors; this is inventory consistency, not migration acceptance.

## Fresh-agent hard gate

This task did not begin with `agent-workflows` in its supplied skill catalog.
Generated directory presence and reading the generated files in this task are
not discovery proof.

Stop after the clean commit. Start a brand-new Codex task at the repository root
on the exact branch and commit reported in the final handoff. The new task
must show `agent-workflows` in its supplied skill catalog, explicitly invoke the
skill, and read its installed contract before it creates any run or controls a
browser. If any condition fails, stop without `workflow train` and report the
discovery gate as blocked.

The first fresh task should remain a discovery/readiness task. Its first runner
mutation, if separately authorized after discovery, must use the ignored
`.workflows/local` Store and the candidate manifest; it must never reuse earlier
Stores or evidence.
