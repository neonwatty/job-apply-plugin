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
- dependency source: `github:lineagehq/workflows#1e9f91c6f6f0a04bdc8003ef1dbbe68ad3468225`
- installed package integrity: `sha512-F2NQKbibyfLW8BJMKk6Ke+J64Pe4buStDMtALjL1dXjYtnjm5R/ZnPIGO20jgGnjkn6sYyk0uA84R6TOHqCzcw==`
- CLI: `node_modules/.bin/workflow`
- minimum Node version declared by the package: `20`

The public npm registry has no `@lineagehq/workflows@0.1.0` release. The exact
Git commit is therefore the distribution identity and reproducibility anchor;
the generated lockfile additionally records the installed package integrity.
The private Git package is optional at the repository level so unrelated CI
jobs can install without private cross-repository credentials; an authenticated
readiness host must verify it is present before using the `workflow` CLI.

The supported `workflow init --host codex` path generated exactly the pinned
Codex skill, its OpenAI metadata, and protocol reference under
`.agents/skills/agent-workflows/`. A second initializer invocation reported all
three files as unchanged.

## Candidate lifecycle

The project config uses a fixed IPv4 loopback port and a repository-local,
ignored run/Store root. Independent review found that ordinary bootstrap could
otherwise import the owner's `~/.claude-job-profile.json`. The Companion
supervisor now accepts an explicit `--legacy-profile`; the candidate command
points it at an intentionally absent path under `.workflows/local`, preventing
that import without changing ordinary launch behavior.

This candidate is conditionally executable, not standalone-executable, under
Workflows 0.1.0. That runner validates and reports the configured start command
but does not execute it, bind the emitted URL, apply a viewport, or execute the
cleanup action strings. Before a future run, an external operator must build
Companion, create `.workflows/local` with owner-only permissions, confirm the
explicit legacy-profile path is absent, and start Companion with the declared
command. Companion emits a fresh authenticated URL. The browser host must use
that complete URL, explicitly apply and verify the selected 1440-by-900 or
390-by-844 viewport, and later stop the process. The static base URL alone is
not authenticated readiness. Runner `cleanup.completed` is not process-teardown
proof, and the isolated Store remains for owner-reviewed external cleanup.

`anonymous` describes the absence of a named applicant identity; it does not
mean unauthenticated HTTP. Companion's ephemeral fragment token is local
transport authorization. Neither identity nor start state is proven by the
runner, so the external host must verify both without reading private data.

Preflight uses the installed host contract's exact matching rules:
`browser.control`, the `file-upload` operation registered on that capability,
and the special `screenshot` evidence type. A fresh host must truthfully
register all three; training-mode gap tolerance is not replay readiness.

The single candidate lifecycle is value-bounded to the committed fictional TXT
fixture. It imports that resume, requests extraction once, and inspects the
proposal-review boundary. It stops with the request queued because the browser
cannot author a Job Apply extraction proposal. A later phase may add a separate
runner-controlled seam for agent-authored proposal completion, but this slice
does not invent one or claim review completion.

Both desktop and mobile browser resolutions are declared, and the mobile
override repeats every base safety constraint because Workflows 0.1.0 replaces
the constraints array rather than merging it. No replay is authorized until
the fresh-agent gate below passes.

## Validation

- `npm ci` reproduced the exact Git dependency and reported zero vulnerabilities.
- `workflow doctor --json` passed with package `0.1.0`, Node `v22.22.3`, and all six expected schema kinds.
- `workflow validate` accepted the project config and candidate workflow.
- `workflow show` resolved five steps for both desktop and mobile; their exact source and effective hashes are in the receipt.
- JSON parsing, `git diff --check`, initializer idempotency, and the assertion that `.workflows/local` remains absent all passed.
- The repository affected gate selected 25 suites because the migration review lock is a global path. The changed Companion suite passed all 88 tests, including the new legacy-profile regression; typecheck, source-size, matrix policy, and migration-evidence also passed.
- The aggregate affected gate remained red for two pre-existing host/policy conditions: the migration inventory refuses an intentionally dirty pre-commit snapshot, and the host's unversioned `python3` resolves to unsupported CPython 3.9 while the migration contract requires 3.12, 3.13, or 3.14. The latter appears both as `Python alias and resolved executable disagree` and as downstream default-interpreter differential failures. Versioned 3.12, 3.13, and 3.14 profiles passed. No frozen host evidence was changed.
- The exact `package.json` hash and its review-lock binding were reconciled after commit. The final clean migration audit reports `inventory-consistent` with no errors; this is inventory consistency, not migration acceptance.
- Independent review checked anonymous/auth wording, token/base URL behavior, capability matching, both viewports, supervisor privacy, ignored Store state, and the installed 0.1.0/protocol 1.0 execution semantics. Its privacy and manifest findings were corrected before handoff; no run was used to validate them.

## Fresh-agent hard gate

This task did not begin with `agent-workflows` in its supplied skill catalog.
Generated directory presence and reading the generated files in this task are
not discovery proof.

Two managed fresh-task provisioning attempts failed before discovery could be
performed. They created no Workflows run and confer no discovery evidence. The
gate therefore remains pending, not passed or failed.

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
