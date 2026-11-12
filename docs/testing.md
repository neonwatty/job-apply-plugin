# Testing the TypeScript release

For install, upgrade, and recovery guidance, see the
[TypeScript transition guide](typescript-transition.md).

The production plugin and required validation use Node.js 22 or newer. Required
checks do not discover, install, or execute CPython. Supported packaged targets
are macOS arm64, Linux x64, and Windows x64. On Windows, run native checks from a
Visual Studio x64 developer prompt after `npx node-gyp install`, so the native lock
can be compiled with `cl` against node.lib. The shipped C/Swift adapters retain their platform checks.

Run `npm ci` at the repository root. Install Chromium for browser checks with
`npx playwright install chromium` (CI uses `--with-deps`).

## Required tiers

```text
npm run test:fast
npm run test:affected -- --base origin/staging
npm run test:full
npm run test:platform
npm run test:release
```

- Fast runs TypeScript/Companion checking, reproducible-build tests, source-size
  policy, workflow auditing, matrix integrity, and runner tests.
- Affected selects required suites for committed and local changes. Ownership is
  deliberately conservative during this cutover: unknown/global changes select
  the full deterministic tier. It never selects Python reference suites.
- Full runs the recurring native unit, Store/CLI, browser, and applicable native
  platform checks. The reference-test inventory explicitly classifies remaining
  historical tests; new test files cannot silently escape classification.
- Platform runs applicable native adapter and activation checks. Other platforms
  are recorded as skipped, not certified as supported.
- Release runs production dependency auditing (blocking high/critical advisories),
  link checks, and the Node package harness, including source-only
  Companion build from a real source-marketplace cache, isolated Codex/Claude
  source and assembled-fixture installation, cache replacement, native
  CLI/browser journeys, critical-byte parity, and restart durability.

The production Companion regressions exercise Jobs-to-Answers navigation, resume
metadata refresh races, explicit fact conflict/discard handling, invalid numeric
drafts, and exact numeric preservation through native Store writes. They use
fictional disposable Stores and headless Chromium. `npm run audit:dependencies`
can also run the release dependency check directly; it needs npm registry access.

Pass `--receipt /absolute/path/result.json` for a value-free suite receipt and
`--concurrency N` to bound parallelism. Receipts report failed checks as failed.

Required runners install a Node subprocess guard and PATH shims that reject
Python/uv execution. An accidental interpreter dependency fails rather than
silently skipping a test. Source-policy and package tooling are Node programs.
The guard preserves Node's callback and promisified child-process contracts.

## One-time historical Python Store migration acceptance

Before releasing the TypeScript transition, run:

```text
npm run test:migration-once
```

Run it from a clean checkout of the exact candidate and retain its final JSON
receipt. Use the manual workflow for both supported platform cells; required CI
never dispatches it automatically.

This explicit command needs Python and Git history. It extracts the actual
v1.1.0 implementation at `07f18ee3c8854df74746492c7a4728fcdf302ff5`, creates
fictional profile, answers, history and session records through that release,
then invokes the candidate's public TypeScript router. It checks original-file
bytes in the active Store and retained backup, native writes across independent
CLI restarts, and explicit rollback. Only after native writers exit does it
verify that the historical release can read the restored Store.

The manual-only **Historical Python Store Migration** workflow runs this check
on Linux and macOS and retains its JSON receipt. It has no PR, push, or scheduled
trigger and is not part of PR gate. Record acceptance against the final release
candidate; an earlier dirty-checkout receipt does not certify a later commit.

`test/fixtures/python-store-v1.1.0` is fictional state captured from that pinned
implementation. Recurring required migration regression tests read it directly
with TypeScript, without running Python. `--capture-fixture` explicitly regenerates
it during historical acceptance; review fixture changes as contract changes.
The historical release did not have the later managed-resume/job Store features;
those remain covered by current native Store and Companion suites.

## Migration inventory audit before main

The Validate Plugin policy job runs this audit and attaches its report to the
policy artifact. To check locally, use a clean checkout with full Git history:

```text
npm run check:migration
```

This Node audit checks current source/surface bindings, reviewed inventory hashes,
and the frozen historical boundary. Historical requirement declarations can refer
to optional reference suites; the audit resolves those Node test bindings without
scheduling suites or making them required CI. Unknown bindings still fail.
A passing inventory receipt does not accept every historical DAG task or replace
behavioral tests and the separate one-time Store migration check. Dirty checkouts
are rejected; a disposable staged snapshot can be used for local diagnosis.

## Optional historical comparisons

`npm run test:reference` retains the historical matrix in
`config/reference-test-matrix.json` for development diagnosis. It may require
specific CPython builds and old implementation contracts. It is not a required
release gate and does not establish current platform or live ATS acceptance.
The former CPython 3.13 atomic-write oracle timeout is outside required CI;
a demonstrated TypeScript persistence defect remains a release issue.

## Companion development

Use `npm run companion:build`, then
`npm run companion:start -- --root /absolute/path/to/private/test-store`.
For development, use `npm run companion:dev -- --root /absolute/path/to/private/test-store`.
The root must be private and owned; its canonical owned parent may allow group
or other read/search permissions, but may not allow group/other writes. The
launcher preserves the parent's permissions. Use disposable Stores for testing.

Raw source-marketplace caches may retain historical reference files. The release
harness verifies native runtime trees separately from its reduced artifact
fixture; it does not claim that a marketplace host strips every Python file.
An interrupted static-asset copy lacks a completed build receipt and is retried
under the build lock on the next launch.

A source-only marketplace installation uses npm and registry access to assemble
Companion on first launch. Later launches reuse the standalone build. Runtime
and packaging checks do not authorize visible account tests on the owner's
browser. Live-browser/native account observations retain separate explicit opt-in.

## CI and local hooks

Validate Plugin runs policy, classification, native unit/CLI/browser shards,
macOS source/adapter checks, and installed-package checks for both supported
platform targets. PR gate requires all selected jobs to succeed. Release
Validation also checks installed packages on Linux and macOS. Nightly runs the
same native full tier. Repository rulesets must separately require PR gate;
a workflow's existence alone does not enforce merge protection.

Install local hooks with `npm run hooks:install`. Hooks use the native required
matrix and Node environment identity; Python is not a local prerequisite.
Historical consumer-graph evidence remains available for reference maintenance,
but it cannot add Python tests to the required plan.

Production code lives under `src/`, checked-in output under `runtime/`, and the
React app under `apps/companion/`. Python trees are historical reference code.
Preserve exact revisions, selective writes, user provenance, browser drafts,
managed-resume identity, consent, and human-only final submission.

Core workflow auditing validates registry consistency and schema validity; it
does not prove live agent or ATS behavior. The live-agent command
`npm run test:agent-local` remains explicit, consumes model capacity, and runs
only against fictional local data. Each of its three trials installs the plugin into a fresh temporary Codex home
and invokes the installed `$job-apply:job-apply` skill. The agent uses the installed public router to
select the exact fictional Ready job, start its detached attempt, grant bounded
review-only authority, and finish at final review with zero final actions. Current live ATS evidence remains the narrow
Pinterest Greenhouse observation; broader current-form coverage is unverified.
