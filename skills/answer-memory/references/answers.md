## Reusable answers

Answer states have distinct behavior:

| State | Meaning | May fill without asking? |
|---|---|---|
| `confirmed` | The user confirmed this value | Yes, only when non-sensitive and scope still matches |
| `inferred` | A candidate derived from context | No; show it and ask |
| `missing` | No supported answer is known | No; ask |
| `sensitive` | Salary, authorization, visa, demographic, disability, or similar | Never; ask before every use |

Look up the exact question and relevant scope before filling:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" answer-find \
  --question "Are you authorized to work in the United States?" \
  --scope '{"country":"US"}'
```

For deterministic semantic candidates and bounded policy, prefer `answer-semantic-lookup --input <private-json>`. The question is ephemeral; the Store recomputes against current canonical records and returns only opaque keys, confidence bands, and closed reason codes. `strict` and `bounded_loose` never imply remember or final-action authority. Sensitive bounded policy additionally requires an explicitly allowlisted field class. `answer-cleanup-preview` is non-mutating. `answer-cleanup-approve --input <exact-preview-selection> --owner-confirmed` is the only semantic-cleanup mutation path and rechecks the complete current preview before a revision-safe coordinator merge.

Store a new reviewed non-sensitive answer with `answer-put --input <answer.json>`. Put creates accepted records only; use `answer-observe` to create pending records and `answer-review` to decline them. Updating through put requires `--expected-revision`; prefer selective `answer-update`. The helper owns stable keys and aliases and rejects normalized question/alias collisions inside the same exact scope.

For the shared answer-library surface, list and selectively edit records through
the helper. Existing records without explicit revisions are exposed as revision
1 and gain durable revision metadata on their next mutation.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" answer-list [--state <state>] \
  [--review-status <accepted|pending|declined> | --all-review-statuses] \
  [--query <text>] [--offset <n>] [--limit <n>] \
  [--include-trashed] [--trashed-only]
python3 "<plugin-root>/scripts/job-apply-store.py" answer-observe --input <observation.json>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-review \
  --key <answer-key> --decision <accepted|declined> \
  --expected-revision <revision> [--input <patch.json>] [--remember-sensitive]
python3 "<plugin-root>/scripts/job-apply-store.py" answer-reveal --key <answer-key>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-update \
  --key <answer-key> --expected-revision <revision> --input <patch.json>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-merge \
  --winner-key <accepted-winner-key> --source-key <active-duplicate-key> \
  --expected-winner-revision <revision> --expected-source-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-trash \
  --key <answer-key> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-restore \
  --key <answer-key> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" answer-delete \
  --key <answer-key> --expected-revision <revision>
```

Legacy active records without `reviewStatus` are accepted without changing their stable keys or scopes. `answer-observe` creates a stable pending `missing` or `inferred` record; repeated observations update value-free observation metadata. This lock-serialized, additive observation update is the sole existing-record mutation that intentionally takes no expected revision: it changes only observation count/timestamps and never replaces canonical answer fields. Derived-key and redirect lookup must still match the record's current exact scope; an occupied historical key at another scope fails observation without mutation. Declined records stay durable for deduplication and are hidden from default views. Generic put/update operations cannot create or transition pending/declined review status; only `answer-review` can transition a pending record to accepted or declined. Every list item omits `value`, including non-sensitive answers, and reports reference counts. Permanent deletion requires trash and fails on any session or append-only history reference.

`answer-merge` requires an explicit accepted winner, an active duplicate source, exact matching scopes, and both current revisions. It preserves the winner value, sensitive-consent marker, source/provenance, state, and confirmation metadata; discards the source value; transfers the normalized source question and aliases; and combines only value-free observation counts/timestamps. A third-record alias collision fails before mutation. Mutable sessions are rewritten atomically through the existing crash-recovery coordinator. History is never rewritten: the removed key becomes a permanent flattened value-free redirect, and reads/reference counts resolve it to the winner. Redirect targets must remain active and cannot be trashed. Never try to reuse, restore, delete, or resurrect a merged source key.

### Sensitive answers require two decisions

Ask separately:

1. May I use this answer in the current form?
2. Would you like me to remember this specific answer for later applications?

Permission to fill is not permission to remember. If the user approves current use but not storage, do not persist the value. You may record a `sensitive` placeholder with `"value": null`.

Persist a non-null sensitive value only after explicit field-specific remember consent in the current interaction:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" answer-put \
  --input <sensitive-answer.json> \
  --remember-sensitive
```

Even a remembered sensitive answer must be shown and reconfirmed before each future form entry.
Changing a stored sensitive value through `answer-update` requires a fresh
`--remember-sensitive` decision. Editing only its aliases or question wording
does not manufacture a new retention decision.
