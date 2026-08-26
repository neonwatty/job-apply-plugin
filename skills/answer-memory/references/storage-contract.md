# Local storage contract

The bundled helper is the sole supported mutation interface:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" --help
```

## Files

- `~/.job-apply/profile.json`: versioned canonical profile and preferences.
- `~/.job-apply/answers.json`: versioned answer records with state, source, scope, aliases, sensitivity, and confirmation metadata.
- `~/.job-apply/jobs.json`: versioned canonical job records with optimistic revisions, focused application status, and recoverable trash state.
- `~/.job-apply/resumes.json`: versioned local resume references with labels, defaults, file observations, revisions, and recoverable trash state.
- `~/.job-apply/applications.jsonl`: append-only minimal application events.
- `~/.job-apply/sessions/<application-id>.json`: resumable workflow metadata with answer-key references.
- `~/.job-apply/auto-submit/campaign.json`: the current closed version-1 campaign record.
- `~/.job-apply/auto-submit/applications/<campaign-ref>/<application-ref>.json`: closed reservations, authorization identity, leases, attempts, and canonical receipts.
- `~/.job-apply/auto-submit/receipts.jsonl`: append-only value-free receipt projection.

Directories use user-only permissions and canonical files use `0600` where the platform supports POSIX modes. JSON writes use a same-directory temporary file and atomic replacement.

Job read-modify-write operations additionally serialize through a private local
store lock. Every mutable job record carries a positive revision. Updates,
transitions, trash, restore, and permanent deletion require the current revision
and fail closed on conflicts.

## Canonical job lifecycle

New jobs start as `saved`. The focused statuses are `saved`, `needs_info`,
`ready`, `in_progress`, `awaiting_review`, `applied`, and `closed`. Closed jobs
require one of `rejected`, `withdrawn`, `expired`, `duplicate`, or
`not_interested` as their outcome. Only a direct user confirmation may authorize
the `applied` transition.

Normal deletion moves a job to recoverable trash. Permanent deletion is accepted
only for an already-trashed record and requires its current revision. Active job
URLs are normalized and unique; URL fragments and default ports do not create a
second job identity.

Readiness preflight returns stable error and warning codes without echoing profile
or resume values. `ready` requires a non-empty valid profile and a current local
file for the assigned or default active resume. Missing role or company and a
resume file that changed since registration remain visible warnings.

### Exclusive ready-job coordinator

Use `job-acquire`, never a standalone transition to `in_progress`, when an agent consumes a ready job. One version-1 `coordinator.json` record holds at most one claim with a hashed token and a 300-second lease; `coordinator-journal.json` provides idempotent crash roll-forward. Neither file is a second workflow-status model: `jobs.json` remains authoritative.
The coordinator files are created lazily by the first claim command, so direct-URL and replay workflows that never use canonical ready jobs retain their existing store shape.

Acquisition requires the caller's selected job revision, re-runs preflight under the store lock, resolves an assigned resume before the default, transitions the job to `in_progress`, and records `job-started`. Terminal handoff requires the post-acquisition or post-recovery revision retained before browser work; callers must not refresh that revision immediately before handoff. Stale revisions fail without mutation. Heartbeat at least every 60 seconds. Heartbeat and all claim-gated mutations require the canonical job to remain `in_progress`; generic transition, trash, deletion, and session-mutation commands reject active canonical jobs. A live claim cannot be recovered, replaced, or silently cleared. After expiry, `claim-recover` must name the same still-`in_progress` job exposed by `claim-status` and rotates the token while recording `claim-recovered`.

Use `claim-progress` for value-free checkpoints. Use `claim-handoff --status needs_info` for a blocked application and `claim-handoff --status awaiting_review` at final review. Each handoff atomically journals the status transition, session, lifecycle history, and claim release. The schema rejects explicit answer-value fields, while callers remain responsible for keeping every allowed metadata string value-free. A `needs_info` job returns through preflight to `ready` and then receives a fresh claim. Claims, journals, sessions, and history must never contain raw tokens, answer values, resume contents, credentials, CAPTCHA/MFA data, or browser state.

## Profile fact updates

`profile-get` remains backward compatible and returns the raw profile.
`profile-inspect` additionally returns the current positive revision and a
JSON-pointer provenance map. `profile-patch` applies a nested object merge patch
under the private store lock and records each changed path as `user`, `resume`,
`agent`, or `migration`. Null removes the selected field. Arrays are replaced as
one fact. A stale expected revision fails without modifying the profile.

## Resume records

Resume records contain only a stable identifier, label, normalized absolute local
path, tags, default selection, file size and modification observation, revision,
timestamps, and trash state. They do not contain resume bytes. A current check can
report that the referenced file is missing or changed without updating the saved
observation.

Only one active resume may be the default. Trashing an actively assigned resume
fails until every active job reference is reassigned or cleared. Permanent
deletion requires an already-trashed record and its current revision.

## Migration

On first initialization, if the new profile does not exist and `~/.claude-job-profile.json` does, the helper copies the complete legacy object into `profile.json`. It preserves unknown keys and leaves the legacy file untouched. Once the new profile exists it is authoritative, so later changes to the legacy file are not re-imported.

Timestamped job-report migration is separately explicit and selective. A
discovery-only `legacy-jobs-preview` reads only regular, direct
`~/.claude-job-searches/search-*.md` files in deterministic order and does not
initialize the canonical store. Discovery is bounded to 100 files, 2 MiB per
file, 20 MiB aggregate, and 5,000 candidate entries; excess, invalid UTF-8,
symlinks, special files, and read-time type drift fail the whole operation.

Selected preview and `legacy-jobs-commit` repeat the same ordered opaque item
IDs. The confirmation token binds that selection, canonical payloads, selected
locators, the complete report manifest and digests, migration origin, and the
current jobs document or missing-store sentinel. Commit locks, rediscovers,
reparses, and rejects drift before a canonical write. Reports are never modified.

Imported jobs use `migration` field provenance and a closed `legacySources`
array containing only source kind, root-relative report filename, deterministic
content-derived entry ID, and SHA-256 digest. Migration may create records, fill empty fields, and
replace fields already authored by migration, but it cannot overwrite nonempty
human- or agent-authored values. Identical reruns are byte-stable no-ops. The job
store is authoritative afterward; arbitrary roots, recursion,
`application_queue.md`, Markdown export, source mutation, and continuous
synchronization are unsupported.

## Versions and corruption

Current documents use `schemaVersion: 1`. A corrupt document, invalid shape, or future schema version causes the helper to fail non-destructively. Agents must not repair canonical files with text editing; preserve the file and explain the error.

Policy state is separately versioned and optional. A v1 answer/profile/history/session store with no policy directory remains valid and resolves to `review_only`. Missing, malformed, old, future, inaccessible, expired, revoked, killed, or mismatched policy state also resolves to `review_only`; it is never migrated into authority.

## Answer identity

Known semantic fields may use documented keys. Dynamic questions receive `question.<sha256>` keys generated from versioned Unicode/whitespace/punctuation normalization plus canonical scope JSON. The helper also checks stored normalized aliases. Agents must call `answer-key` or `answer-find`, never implement this algorithm themselves.

Only a non-sensitive `confirmed` answer with matching scope may be reused without asking. `inferred`, `missing`, and every `sensitive` record require review. A stored sensitive value must carry the helper-generated consent timestamp, and the agent still reconfirms it before use.

Answer records carry orthogonal `reviewStatus` (`accepted`, `pending`, or `declined`) and optimistic revisions. Legacy active records default to accepted; their stable key and exact scope do not change. Generic put creates accepted records only. Observed questions are canonical pending missing/inferred answer records, never a second store; only dedicated review can decline them. Declined records remain durable to deduplicate later observations. Within one exact scope, normalized questions and aliases cannot collide across records. Derived-key and redirect fallback must match the target record's current exact scope; observation fails without mutation when a historical stable key is occupied at another scope.

Search/list projections are stable, paginated, strictly type-check query filters, and omit all answer values while reporting `hasValue`, redaction state, and value-free session/history reference counts. Get, find, and mutation responses also omit retained sensitive values; only explicit reveal of an active record returns one. Repeated or concurrent observations add counts and timestamps under the store lock without replacing canonical answer fields. This lock-serialized additive `answer-observe` path is the sole existing-record exception to expected-revision input; every other mutation of an existing record, including put/upsert, requires its revision. Generic put/update operations cannot transition `reviewStatus`; only the dedicated review operation can move a pending record to accepted or declined.

Browser answer routes carry the full UTF-8 key in a base64url path segment so valid explicit keys such as `.` and `..` never pass through browser dot-segment normalization; authentication, exact-origin mutation checks, and route allowlisting remain unchanged. Detail, find, list, and explicit reveal resolve redirects, records, values, projection metadata, and reference-key interpretation from one Answers document snapshot. A reveal response is applied only when both the open dialog and response still have the requested canonical identity; a concurrent merge response is never placed into the source dialog. Overlapping detail requests are sequenced, and merge is blocked while the source form has an unsaved draft so a draft is never silently retargeted or discarded.

Answer merge requires an explicitly selected accepted winner and an active duplicate source at the same exact scope and at both exact revisions. The winner retains its value, consent, provenance, sensitivity, state, and confirmation metadata. The source value is removed; its normalized question/aliases transfer after a pre-mutation third-record collision check; and only observation count plus earliest/latest timestamps are combined. The source becomes one permanent value-free redirect directly to an active canonical winner. Redirects cannot chain, cycle, dangle, be deleted, target a trashed record, or resurrect a merged key; a redirect target cannot be trashed.

The existing coordinator journal serializes the Answers document transition with rewrites of every mutable session `answerKeys` and pending-field `answerKey`. Its merge operation contains only keys, revisions, timestamps, the unchanged claim, and closed value-free session documents—never an answer value. Recovery rolls the operation forward idempotently after any interrupted write. Append-only history is never rewritten; reads, reference counts, and deletion guards resolve its old keys through redirects. A redirect target cannot be permanently deleted.

Changing a retained sensitive value requires a fresh field-specific remember
decision. Updating non-value metadata on an already consented sensitive record
preserves its consent marker. Permanent deletion requires recoverable trash first and fails while any session or append-only application-history event references the answer key. History is never rewritten to enable deletion.

## Data minimization

History and sessions reference answer keys instead of copying values. Standalone history append is serialized with answer deletion and accepts each new answer reference only when its key is an existing answer or immutable redirect; whichever operation wins the lock makes a concurrent append/delete attempt fail safely. Existing append-only lines remain unchanged. Their input schemas are closed: arbitrary nested applicant payloads are rejected. Credentials, browser state, CAPTCHA/MFA data, and payment information are never valid storage inputs.

## Approved replay lifecycle

Approved loopback QA runs record `started` and `reviewed` through `qa-replay.py`, which delegates to the store helper's closed `replay-transition` command. The application identity is the generated run ID; callers cannot supply a second identity or persistence location. Transitions are idempotent, ordered, limited to Greenhouse, LinkedIn Easy Apply, Ashby, and Lever fixtures, and keep using `applications.jsonl` plus the matching session document. They contain no applicant answers, private URLs, route or shutdown tokens, resume content, or browser state. A reviewed transition is accepted only for a nonterminal run after its correlated replay review event and while the final-action activation count remains zero.

## Auto-submit campaign contract

`job_apply_policy.py` is the only supported policy mutation interface. It is deliberately inert and imports no browser-control implementation. Its closed campaign record contains only:

- an opaque campaign reference, fixed `auto_submit` mode, lifecycle status, creation/expiry timestamps, risk-acknowledgement timestamp, and persisted kill-switch state;
- a maximum of ten application reservations and a duration no longer than four hours;
- immutable exact application rules: opaque application reference, exact HTTP(S) origin, ATS label, and SHA-256 fingerprints for URL, job, form, and final control;
- one opaque resume revision fingerprint; and
- an exact sensitive allowlist containing opaque answer references plus question and answer revision fingerprints; and
- an opaque confirmation-authority revision binding the campaign to its private executor capability without storing that capability.

Raw URLs, question text, answers, resume content, credentials, and browser/session values are not schema fields. Unknown fields and non-opaque references or revisions are rejected. An active or killed campaign cannot be replaced to widen scope.

## Reservation, lease, and outcome contract

All campaign changes, application-slot reservations, lease issuance, kill-switch changes, and receipt appends serialize through a user-private filesystem lock. Application records are atomically replaced. Occupied slots are recovered from closed per-application records under the lock, so restart or a process failure between record writes cannot reuse a slot. A repeated identical authorization returns the same unexpired lease; changed authorization identity fails closed.

Each one-time lease binds the campaign, application, slot/ordinal, exact origin/application rule, resume/form/final-control revisions, sensitive-answer revisions, issue time, and expiry. Immediately before synthetic activation, the isolated endpoint invokes the policy authority under the same lock to recheck all of those facts plus campaign mode, kill switch, campaign expiry, lease expiry, ordinal, retry state, and the private capability. It durably changes `lease_issued` to `action_claimed` and performs the synthetic activation before releasing that lock; exactly one concurrent caller wins. A detached claim or proof cannot activate. Thus kill/expiry linearized first refuses with zero activation, while an activation linearized first cannot be duplicated. The first uncertain outcome transitions to `retry_available`; the only permitted retry uses the same reservation and creates attempt two. A second uncertain outcome persists terminal `uncertain_exhausted`. `blocked` and `confirmed_submitted` are terminal. A click or caller digest is not confirmation; `confirmed_submitted` requires a distinct trusted event that independently observed activation.

Each consumed attempt stores a canonical closed receipt before its append-only JSONL projection. Repeating the same outcome is idempotent and repairs a missing projection without creating a different receipt. Receipts contain references, ordinals, timestamps, status, outcome, and optional confirmation fingerprint only.

## Kill switch and browser boundary

`kill` atomically marks the campaign killed and persists the kill switch. Every subsequent status or authorization decision is `review_only`, including after restart. `revoke` also ends authority without claiming a kill event.

Policy authorization is not browser execution. The private-capability isolated-loopback QA adapter is the only currently approved executor. Live browser work must still stop at review until the later separately approved canary gate.
