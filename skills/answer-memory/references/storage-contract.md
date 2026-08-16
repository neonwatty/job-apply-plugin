# Local storage contract

The bundled helper is the sole supported mutation interface:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" --help
```

## Files

- `~/.job-apply/profile.json`: versioned canonical profile and preferences.
- `~/.job-apply/answers.json`: versioned answer records with state, source, scope, aliases, sensitivity, and confirmation metadata.
- `~/.job-apply/applications.jsonl`: append-only minimal application events.
- `~/.job-apply/sessions/<application-id>.json`: resumable workflow metadata with answer-key references.
- `~/.job-apply/auto-submit/campaign.json`: the current closed version-1 campaign record.
- `~/.job-apply/auto-submit/applications/<campaign-ref>/<application-ref>.json`: closed reservations, authorization identity, leases, attempts, and canonical receipts.
- `~/.job-apply/auto-submit/receipts.jsonl`: append-only value-free receipt projection.

Directories use user-only permissions and canonical files use `0600` where the platform supports POSIX modes. JSON writes use a same-directory temporary file and atomic replacement.

## Migration

On first initialization, if the new profile does not exist and `~/.claude-job-profile.json` does, the helper copies the complete legacy object into `profile.json`. It preserves unknown keys and leaves the legacy file untouched. Once the new profile exists it is authoritative, so later changes to the legacy file are not re-imported.

## Versions and corruption

Current documents use `schemaVersion: 1`. A corrupt document, invalid shape, or future schema version causes the helper to fail non-destructively. Agents must not repair canonical files with text editing; preserve the file and explain the error.

Policy state is separately versioned and optional. A v1 answer/profile/history/session store with no policy directory remains valid and resolves to `review_only`. Missing, malformed, old, future, inaccessible, expired, revoked, killed, or mismatched policy state also resolves to `review_only`; it is never migrated into authority.

## Answer identity

Known semantic fields may use documented keys. Dynamic questions receive `question.<sha256>` keys generated from versioned Unicode/whitespace/punctuation normalization plus canonical scope JSON. The helper also checks stored normalized aliases. Agents must call `answer-key` or `answer-find`, never implement this algorithm themselves.

Only a non-sensitive `confirmed` answer with matching scope may be reused without asking. `inferred`, `missing`, and every `sensitive` record require review. A stored sensitive value must carry the helper-generated consent timestamp, and the agent still reconfirms it before use.

## Data minimization

History and sessions reference answer keys instead of copying values. Their input schemas are closed: arbitrary nested applicant payloads are rejected. Credentials, browser state, CAPTCHA/MFA data, and payment information are never valid storage inputs.

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
