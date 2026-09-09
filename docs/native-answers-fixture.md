# Native Answers leaf tranche

This tranche provides lossless answer contracts, shared domain services, HTTP/CLI
leaf adapters and a React editor. It is not a complete phase 8 migration or a
live Store activation. Native fixture version 5 wires these services into the
shared Store lock, HTTP and CLI dispatch, and the Answers tab. Existing fixtures
are rejected rather than upgraded; initialize a new isolated fixture using the
[native fixture guide](native-jobs-fixture.md).

## Repository integration

`AnswersService` receives an `AnswerRepository` implementing:

```ts
answerTransaction<T>(operation: (
  document: Document,
  save: (document: Document) => Promise<void>,
  references: ReadonlyMap<string, { sessions: bigint; history: bigint }>,
) => Promise<T>): Promise<T>;
```

The repository owns cross-process locking, private-path validation, loading and
atomic durable replacement of `answers.json`. It must hold the lock across the
callback, supply a detached lossless document, validate before saving, and reject
unsupported recovery journals without changing them. The domain validates all
answer records and flattened redirects before reads or writes. Unknown record
and metadata fields are preserved during edits.

Reference counts must include sessions and history and resolve redirected keys.
An empty map is safe only in fixtures that reject all unsupported session and
history state. This leaf cannot assert real Store reference counts or writer
exclusion on its own. Do not open an existing Python Store with these leaves.

`answerHttp(repository, method, path, body)` returns a serialized response or
`null` for unsupported routes. The parent owns authentication, body limits,
error-to-status mapping and unsupported-route handling. Encoded `by-key` paths
use UTF-8 base64url. Supported routes are query, put, observe, detail, update,
explicit reveal and accept/decline. Semantic lookup is available through
`POST /api/answers/semantic`; cleanup routes remain unsupported.

`answerCommands` and `runAnswerCommand` provide answer-key, get, find, list, put,
observe, update, reveal and review. The native parser recognizes the boolean
flags `--remember-sensitive`, `--include-trashed`, `--trashed-only` and
`--all-review-statuses`. Review uses the existing `--decision` option. Exact
question/alias lookup and deterministic semantic reuse evaluation are supported.
`answer-semantic-lookup --input FILE` (or `--input -`) evaluates a lookup packet
against current canonical records under the shared Store lock.

The semantic packet requires `question`, `scope`, `fieldClass`, `sensitivity`,
`mode`, and `useAuthority`. Optional fields are `limit` (1–100, default 5) and
`allowedSensitiveFieldClasses`. Modes are `strict` and `bounded_loose`;
authorities are `none`, `accepted_record`, `per_use`, and `bounded_policy`.
The response contains value-free candidate keys, confidence bands and reason
codes, plus `mutated: false`. Matching preserves negation and downgrades ambiguous
leaders. Compatible scope, category, sensitivity, accepted confirmed state,
present value, confidence and explicit authority are all required for
`reuse_eligible`. Sensitive reuse in strict mode requires per-use authority;
bounded-policy authority also requires bounded-loose mode and an allowlisted
field class. These decisions do not authorize remembering a value, changing
application state or submitting an application. Pending-field resolution still
requires the coordinator workflow.
Normalization and tokenization follow Python 3.12's Unicode 15 tables, including
on newer Node runtimes. The checked-in character ranges are generated with
`tools/contracts/answer-matching/unicode.py` using that explicit Python version.

## React integration

Render `Answers` with `dirtyChanged` and an authenticated `AnswerClient` whose
`answerRequest(path, method, body, signal)` returns raw response text. Use the
existing bounded request transport in raw mode so integer and float tokens do
not pass through ordinary JSON parsing.

The leaf supports creating answers, value-free search, status filters, selecting an answer,
explicit sensitive reveal, ordinary labeled fields with lossless typed value editing, accept/decline, draft retention
and selective reapply after loading a newer revision. Consent starts unchecked
and resets after selection, save and conflict reapply. Unsupported merge,
cleanup and pending application questions are identified in the UI. New answers
use labeled fields and default to confirmed user facts. Creation omits an
expected revision so duplicate identities are rejected atomically; failed
creation retains the draft. Each new form starts with sensitive-memory consent
unchecked, and saved sensitive values return to a hidden state. The native
browser walkthrough covers creation, duplicates, discard, editing, CLI conflicts and selective
reapply, sensitive reveal and remember consent, pending review and saved reload.

## Verification and remaining work

Run `node --test tests_js/workspace_native_answers.test.mjs` after emitting the
runtime. The focused suite includes an independent Python Store on a fresh
separate temporary root, Unicode/numeric key checks, mutation/projection parity,
privacy, stale revisions, collisions and HTTP/CLI validation. Its native domain
repository is an isolated in-memory transaction fixture; it does not substitute
for disk durability or cross-process integration. The companion
`workspace_native_answers_integration.test.mjs` exercises real HTTP/CLI disk
state, concurrent revisions, failed persistence, corrupt documents and rejected
unsupported reference state. Existing native lock and atomic-write fault tests
remain required; the domain tests alone do not certify crash recovery.

Merge and cleanup commit require the coordinator journal plus reference/session
rewrites. No single-document substitute is supplied. Full phase 8 acceptance
also requires complete React workflows, coordinator recovery and full release acceptance.

## Cleanup preview

`GET /api/answers/cleanup-preview` and `answer-cleanup-preview` return the same
revision-bound preview under the shared Store lock. The Answers screen offers
**Preview cleanup**, including loading, retry and empty states. It lists the
accepted winner and pending duplicate questions, without revealing stored values.
A successful answer save clears the displayed preview; refresh the preview after
changes from another client.

Only an unambiguous exact/high match with compatible scope, field class and
sensitivity is proposed. The winner must be active, accepted, confirmed and have
a retained value; the duplicate must be active and pending. Multiple eligible
winners suppress a proposal. The `answer-cleanup-v1` token covers the proposals
and every answer revision using the Python-compatible canonical representation.
Preview is read-only: it neither merges answers nor grants approval. Cleanup
approval and durable merging remain unavailable in this fixture.
