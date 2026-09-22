# Application setup local live-agent replay

Date: 2026-09-22

Scope: local-only synthetic validation of
`job-apply.synthetic-application-setup-preferences` from the
`codex/application-setup-preferences` worktree. This was a supervised host replay,
not a promoted evaluation or a claim that the Agent Workflows runner launched the
Codex agents itself.

## Result

Passed after fixing two issues found by the replay.

1. The isolated Codex home was originally nested under the plugin source. Plugin
   installation recursively copied its destination and failed. Preflight now
   requires an explicit, absent Codex home outside the repository and rejects a
   descendant path.
2. `apps/companion/command.mjs` treated an explicitly initialized native QA Store
   as legacy state and attempted a canonical clone. It now validates the native
   fixture ownership marker and uses the Store directly. Tampered fixture markers
   remain rejected.

The first failed, run-owned plugin cache was initially moved to Trash, then
permanently removed because retaining its isolated authentication copy in Trash
would be unsafe. The successful run's copied authentication file was zeroed before
its cache was moved to Trash. No owner plugin installation, default Job Apply
Store, employer site, ATS, or external account was accessed.

## Live writer agent

- A fresh Codex process used an isolated Codex home containing the exact worktree
  plugin version.
- Its runtime command trace showed reads of both `application-setup/SKILL.md` and
  `answer-memory/SKILL.md`.
- Before answers were supplied, it asked exactly the preferred-browser,
  unavailable-browser, and page-progression questions and performed no Store
  inspection or mutation.
- After receiving `Chrome`, `Ask before switching`, and `Guided`, it wrote the
  revision-checked patch and freshly inspected the result.
- Its redacted result matched the independent canonical inspection at revision 3:
  `chrome`, `ask`, and `guided`.

## Companion durability round trip

- Settings loaded the writer-agent values without changing revision 3.
- The UI changed the values once to `codex_browser`, `other_supported`, and
  `standard`; the canonical profile advanced exactly once to revision 4.
- A full reload preserved all three selections.
- Overview displayed `Application setup saved`.
- The UI continued to describe login, passwords, CAPTCHA, MFA, sensitive-answer
  approval, and final submission as always manual.
- The canonical task snapshot remained empty for jobs, resumes, sessions,
  application activity, and attention items.

Redacted UI evidence was captured as baseline JFIF JPEG at 1280 by 720. SHA-256:

- live-agent setup audited: `1c445acc0b7cd2964d39d2ca42398c94a95749c29322f9c61113efc06ad3afcd`
- Companion setup edited: `ee6a9500f0188f845d329fca4cae63f83c92862a89fceaee030f9a37339d004f`
- Companion setup reloaded: `227a961ff88e691f725f4349e487b83f9ecf8584e637f3ea6b404bcb46e0557c`
- fixed safety boundaries: `c0ff44d5a83789ae3437bde495d9ff6be82d06f5a04581b990e754d44e65edb2`

## Live reader agent

- A second fresh Codex process independently read the two installed skills.
- It performed two profile inspections, no `profile-patch`, and did not start the
  questionnaire.
- Its redacted result reported revision 4 and
  `codex_browser`, `other_supported`, and `standard`.
- An independent canonical inspection still reported revision 4 with the same
  values.

## Evidence boundary

Raw Codex JSONL, route material, isolated authentication, Store paths, and bearer
tokens were kept only in local run artifacts and were zeroed after verification.
The QA coordinator completed its abandoned-run cleanup, shutting down the fixture
server and sanitizing the routing secret and synthetic profile content. The durable
receipt contains only bounded outcomes and hashes.
