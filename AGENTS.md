# Codebase modernization architecture

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
