# Repository guidance

## Search hygiene

Determine the repository boundary with `git rev-parse --show-toplevel`. Keep searches inside it; use `rg` and `rg --files`. Do not recursively search dependencies, generated output, caches, or sibling worktrees unless the task requires them. Never use `find ..` from a worktree.

## Task completion and verification

Finish the requested change, run affected checks, and fix failures caused by the change. Read documentation relevant to the changed workflow; no full repository survey is required for a small edit.

Use `npm run test:affected -- --base origin/staging` for the affected suite selection; see [testing tiers](docs/testing.md) for options and broader release checks. Use the existing commit/push hooks rather than repeating a successful unchanged suite. Isolated fixture checks may run without repeated approval. Disruptive visible-browser/native account tests retain their explicit opt-in; never run them against the owner’s active browser merely because another local check needs them.

For skill changes, keep entry points concise and load references by task. Coordinate agent instructions with Companion status, draft preservation, and handoff behavior. Preserve manual submission, consent, managed-resume identity, and revision boundaries. Include reachable references in documentation and installed-package checks.

Buffer context is relevant only to Buffer publishing or analytics tasks; use the available `buffer-workflows` skill for those tasks.

## Code Review Rules

- Before creating a PR, run `codex-pr-review-toolkit:review-pull-request` as a read-only **branch review** against the intended PR base. Resolve validated findings locally, rerun affected checks, and repeat the review if the diff changes materially; only then push/create the PR. If the toolkit is unavailable, stop and report that the pre-PR review gate was not met rather than using CI as the first review pass.
- For canonical Store, profile, or Companion mutation changes, verify exact-revision conflict handling, selective writes, user provenance, and preservation of unrelated facts/preferences and browser drafts; these are contracts exercised by `npm run test:affected -- --base <intended-base>` and the relevant workspace tests.
- For skill, runtime, or packaging changes, verify the installed Codex/Claude artifacts and Companion handoff with `npm run test:release`; source-tree tests alone do not prove the packaged workflow.
- When a local gate is red, identify whether the same failure reproduces on the clean base and report the gate as red until it passes; do not present a baseline reproduction as a green result.

## Codebase modernization architecture

Keep behavioral, CLI, JSON, HTTP, privacy, and persisted-data contracts stable
through the modernization. Preserve human-only final submission. Python and
TypeScript writers must not mutate the same live Store during migration.

## Source-size policy

Scoped source, tests, test support, launchers, and checked-in runtime code must
remain at or below 500 physical lines. A physical line is each newline plus a
final non-empty unterminated line. Do not evade this policy through minification,
statement packing, comment deletion, or generated indirection.

Run `npm run check:size` for relevant changes. Existing exceptions in
`.source-size-baseline.json` may only shrink: lower a ceiling in the same change
when its file shrinks, remove the entry once the file is at most 500 lines, and
remove obsolete entries when a file is renamed or deleted. Never add an
exception or raise a ceiling.

## Worker packages

Each worker package must declare `allowed_files`. If it touches an oversized
file recorded in `.source-size-baseline.json`, its `allowed_files` must name at
least one extraction target for that file. Keep module dependencies directional:
new leaf modules may depend on shared primitives, but shared primitives and
facades must not depend on leaves. One owner edits the Store facade and one
owner edits the workspace bootstrap at a time.
