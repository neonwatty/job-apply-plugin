# Native Answers leaf tranche

This tranche provides lossless answer contracts, shared domain services, HTTP/CLI
leaf adapters and a React editor. It is not a complete phase 8 migration or a
live Store activation. Native fixture version 4 wires these services into the
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
explicit reveal and accept/decline. Semantic lookup and cleanup routes remain
unsupported.

`answerCommands` and `runAnswerCommand` provide answer-key, get, find, list, put,
observe, update, reveal and review. The native parser recognizes the boolean
flags `--remember-sensitive`, `--include-trashed`, `--trashed-only` and
`--all-review-statuses`. Review uses the existing `--decision` option. Exact
question/alias lookup is supported; semantic reuse authorization is not.

## React integration

Render `Answers` with `dirtyChanged` and an authenticated `AnswerClient` whose
`answerRequest(path, method, body, signal)` returns raw response text. Use the
existing bounded request transport in raw mode so integer and float tokens do
not pass through ordinary JSON parsing.

The leaf supports value-free search, status filters, selecting an answer,
explicit sensitive reveal, ordinary labeled fields with lossless typed value editing, accept/decline, draft retention
and selective reapply after loading a newer revision. Consent starts unchecked
and resets after selection, save and conflict reapply. Unsupported merge,
cleanup and pending application questions are identified in the UI. Creation is
available through the service/CLI/HTTP; the leaf UI does not yet have a creation
form. The native browser walkthrough covers editing, CLI conflicts and selective
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
also requires semantic matching/reuse policy, cleanup preview binding, complete
React workflows, coordinator recovery and full release acceptance.
