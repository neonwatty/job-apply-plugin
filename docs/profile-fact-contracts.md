# Python profile/fact mutation reference

Base: `8b85729e3f936fdbe124d6b3634c7ad421461215` (PR49 at dispatch).
This is a synthetic CLI reference corpus, not a TypeScript Store or runtime cutover.

The dedicated fixture calls the authoritative parser, dispatcher and Store methods
in `scripts/job-apply-store.py`. Inspection of `cli_parser.py`, `cli_dispatch.py`,
`domains/profile.py`, `domains/profile_facts.py` and profile-answer validation
established the inputs before capture. There are 19 cases for four commands:

| Command | Frozen cases |
| --- | --- |
| `profile-patch` | Nested merge, nested null deletion, JSON-pointer escaping, exact no-op, stale revision, lower-authority overwrite of user provenance, empty patch, non-object input |
| `fact-group-create` | Whitespace-trimmed label/default order/deterministic UUID, case-insensitive duplicate label, invalid pointer, unsupported input field |
| `fact-group-update` | Label/path/order change with revision increment, no-op, stale revision, invalid boolean order |
| `fact-group-delete` | Successful removal, stale revision, missing record |

Every scenario starts with a newly initialized disposable Store. Setup uses only
synthetic CLI inputs. Fixed time is `2026-09-05T00:00:00Z`; the UUID counter starts
at one and the nonce provider is deterministic. Recorded mutation UUID calls must
be one for successful creation and zero otherwise; nonce calls must be zero.
Temporary atomic-write filenames remain OS-generated and are never serialized.
The CLI's stdin JSON interface is used, without replacing input validation.

The before snapshot ages files to a fixed 2020 mtime. The fixture checks the
entire Store tree: exact file bytes, nanosecond mtimes, modes, entry kinds,
directory presence and identity. Directory mtimes are deliberately excluded
because atomic replacement changes the containing directory. Root identity and
mode are checked too. Only the transient `.store.lock` entry is excluded. Each
successful changed case permits exactly `profile.json` or `fact-groups.json`;
no-op and rejected cases permit no changes. Raw before/after persisted text is
frozen alongside exact stdout/stderr strings, exit status, write sets and mtime
change evidence. The comparisons catch unlisted writes, removals and temporary
file leftovers. No hashes substitute for the persisted content comparison.

POSIX capture requires private files (`0600`) and directories (`0700`). The
reference was verified on macOS. Windows ACL/security-descriptor parity is not
claimed or tested here; the mode marker explicitly names that limitation. Raw
persisted newline bytes are not normalized, so Windows newline differences may
require a separately reviewed platform reference. Only process stream newlines
are normalized to LF. Cross-platform execution and Windows permission coverage
remain integration work, not proof supplied by this receipt.

Secret canaries live in rejected CLI inputs. After every operation the driver
checks stdout, stderr and all persisted file contents; the final artifact and
its descriptors also pass a redaction validator. Descriptors use the literal
`<secret-canary>` placeholder. Closed JSON Schema validation freezes all scenario
identities, inputs, expected counters and effects; negative tests reject unknown
fields and canary-bearing outputs with value-free diagnostics. Successful
profile output intentionally includes synthetic facts: this is not a general
redaction policy for successful applicant facts.

## Capture and review

Run with existing development dependencies installed:

```sh
node --test tests_js/python-profile-fact-contracts.test.mjs
node tools/contracts/profile-facts/capture.mjs --output /tmp/profile-fact-candidate.json
```

The capture CLI rejects extra arguments, caller-provided Store roots, repository
output locations (including directory symlink aliases), and existing files.
The Python driver independently rejects arguments and constructs all Store roots
with `TemporaryDirectory`; it has no input path/root override. Candidates cannot
silently refresh a committed golden. Inspect a fresh candidate and deliberately
copy an approved reference through normal review. Tests compare two fresh
captures to the committed vector and exercise candidate output protection.
The existing startup harness and its restricted allowlists are unchanged.

## Deferred coverage

Omitted commands include `profile-replace`, `preferences-set`, profile
preparedness mutations, profile/fact reads and all other Store command families.
Within captured commands, parser flag errors, all other validation boundaries,
atomic/deleted profile paths (not exposed by this CLI command), inherited
provenance refinements, missing/corrupt/future/legacy Stores, trash, concurrency,
symlinks/reparse attacks and crash boundaries are not covered. Setup always
begins with a clean initialized Store. These four methods use direct atomic JSON
writes and have no mutation journal of their own; restart recovery and crash
injection are deferred, rather than simulated by a speculative abstraction.
No production Python, common schemas, startup helpers or launchers changed.

## Requested integration patch

The integration owner should register this direct test in the existing suite;
no package script, common redaction tool or shared build changes are required.

```diff
--- a/config/test-matrix.json
+++ b/config/test-matrix.json
@@
-      "include": ["tests_js/workspace*.test.mjs", "tests_js/unified_task_spine_oracle.test.mjs", "tests_js/python-contracts.test.mjs", "tests_js/python-startup-contracts.test.mjs"],
+      "include": ["tests_js/workspace*.test.mjs", "tests_js/unified_task_spine_oracle.test.mjs", "tests_js/python-contracts.test.mjs", "tests_js/python-startup-contracts.test.mjs", "tests_js/python-profile-fact-contracts.test.mjs"],
```

The existing `tools/contracts/**` ownership rule already selects that suite.
Schema/vector changes already trigger global affected selection. Python fixture
files are dedicated test tooling, not additions to the shipped runtime.
