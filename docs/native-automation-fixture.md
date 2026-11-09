# Native automation and employer-account control plane

This tranche supplies native settings, realm resolution, and employer-account
registry services, stranded account-operation recovery, and injected synthetic
protected-account execution for explicit fixtures. It does not activate a Store
writer, initialize an existing Store, inspect the owner's browser, or call the
owner's credentials. New fixtures use version 12 and require the account
documents, `account-operation-journal.json`, and `trusted-fill.json`. Existing
version 11 roots are rejected rather than upgraded or adopted; earlier fixture
documents describe their historical version. Missing documents and unsupported
trusted-fill records remain rejected.

## Composition and persistence

`src/store/native-automation.ts` exports `initialAutomationDocuments(now)` and
`createAutomationRepository(locked)`. The former returns Python-shaped initial
`automation-settings` and `employer-accounts` documents. Call it only while
creating a new fixture, before the readiness marker is written.

The repository factory accepts a callback that supplies `read(name)` and
`write(name, document)` inside the existing validated root and exclusive Store
lock. `NativeJobsRepository.automationTransaction` supplies private owned regular-file
checks, no links, point-JSON parsing, schema checking, atomic persistence, and
fixture readiness under the existing lock and recovery boundary.
Domain reads are lazy. Settings methods request only settings; account methods
request only accounts. The shared fixture transaction still validates and may
recover existing resume/session state before invoking the domain callback; this
is the synthetic fixture policy, not general Python Store adoption parity. Profile email copy loads the canonical profile first, checks its
revision, then checks settings revision and email. No read initializes or repairs
missing documents. Save callbacks validate and write only their named document.

`AutomationService` implements get, update, and profile email copy. Settings
patches use exactly the Python fields and increment the revision even for an
unchanged value. Profile copy always conceals the copied identity, including its
internal `{copied, revision}` response. `AccountsService` implements resolve,
list, get, create, and email-override update. Account records preserve the legacy
shape and provider/lifecycle constraints. Registry creation does not provision a
credential. Public projections omit email, descriptor, provider ID and credential
reference, retaining the Python revision and configured/assigned flags.

The realm resolver retains Python URL identity rather than WHATWG rewriting:
Workday tenant host and cell, Oracle tenant host and career site. Unsupported
hosts, ambiguous gateways, userinfo, fragments and credential query parameters
remain unresolved with fixed reason codes. It performs no external lookup.

`AccountOperationService` implements redacted operation status and explicit
fail-closed recovery. Recovery marks the bound account ambiguous, hands a live
same-job claim to `needs_info` with browser-state-uncertain evidence, and clears
the matching operation journal only after durable account and coordinator work.
An already `needs_info` job can finish clearing a prior partial recovery. No
path infers account success, permits retry, invokes a provider, or performs a
final application action.

`SyntheticAccountService` ports the protected synthetic execution contract. It
accepts only an injected executor, an exact live job claim, exact job/settings/
account revisions, a proven realm, and a loopback target bound by reviewed
fingerprints. The journal is durably prepared before the injected effect and is
advanced after each account stage. Executor failure burns the attempt as
ambiguous and hands the job to Needs Attention; non-active observed outcomes do
the same with their specific blocker. Public responses exclude the effective
email and credential reference. The ordinary HTTP composition supplies no
provider, so it rejects the synthetic route without mutation.

## HTTP boundary

`automationHttp(repository, method, path, body)` supports these Python routes:

- POST `/api/automation/realm-resolve`
- PATCH `/api/automation/settings`
- POST `/api/automation/settings/copy-profile-email`
- POST `/api/employer-accounts`
- GET/PATCH `/api/employer-accounts/{realmRef}`

`accountOperationHttp(repository, method, path, body)` supports:

- GET `/api/account-operation`
- POST `/api/account-operation/execute-synthetic`
- POST `/api/account-operation/recover`

`trustedFillHttp(repository, method, path, body, dependencies)` supports:

- POST `/api/trusted-fill/approve`
- GET `/api/trusted-fill/{id}`
- POST `/api/trusted-fill/evaluate`
- POST `/api/trusted-fill/{id}/revoke`

Approval binds the current live claim, job and URL, managed resume bytes,
profile and accepted answers, settings, optional employer account, observed
fingerprints, operation allowlist, policy revision, and expiry. A successful
evaluation durably consumes the approval before returning its one-shot non-final
authority. Replay, stale revisions, final actions, claim replacement, drift,
and every human boundary deny without retry. Canonical denials hand the live
claim to Needs Attention; a missing, expired, or replaced claim cannot hand off
a newer owner. HTTP status and decisions omit private values, file identity,
nonce, and claim credentials.

`TrustedFillNativeService` is the protected effect boundary after evaluation.
It refuses to consume authority unless an internal native provider is injected.
The HTTP dispatcher now routes evaluation through that boundary and accepts the
provider only as an internal dependency. The ordinary server supplies no
provider, so evaluation rejects before consuming an approval or mutating Store.
The provider receives only an operation fingerprint, the exact observed form
fingerprints, the approved non-final operation set, and the pre/post-consumption
approval revisions. Private values and browser identity remain provider-owned.
The receipt must echo the operation fingerprint and exact operation set, attest
that no final, authentication, consent, or credential control was touched, and
confirm that private values were cleared. A missing, stale, malformed, or
authority-widening receipt cannot report success. Native ambiguity consumes the
approval and hands the same live claim to Needs Attention. Claim replacement
during the effect is left untouched.

It returns a response or null for an unowned route. The composing HTTP boundary
retains the existing safe request/storage error envelope and revision-conflict
status mapping through `jobsHttp`. All mutation/detail responses use public projections.
GET `/api/automation` returns the redacted settings and account registry with the
profile revision and a side-effect-free native capability projection. The
projection truthfully reports that no native credential or account-flow provider
is composed and that live execution remains disabled. There are no invented
settings-list or account-list GET endpoints.

## Follow-on dependency map

Python authorities remain read-only:
`scripts/job_apply_store/domains/accounts/{settings,registry,trusted_fill,synthetic,operations}.py`,
`scripts/job_apply_store/validation/accounts.py`, `scripts/job_apply_accounts.py`
and `scripts/job_apply_trusted_fill.py`.

Trusted-fill approval, evaluation, status, revocation, one-shot consumption,
and denial handoff now share the native Store lock and coordinator journal.
The native email-only transaction now validates exact Oracle realm, job, claim,
settings, account, portal, and control bindings before writing a durable attempt.
It advances the credential-free account to `signup_in_progress` before invoking
an injected test provider, accepts only the closed non-final attestation shape,
and persists either the observed lifecycle or an ambiguous Needs Attention
handoff. Concurrent attempts serialize under the Store lock and can invoke the
provider only once. The ordinary server does not expose or compose this provider.

The retained Swift email-only boundary now has a TypeScript macOS adapter. It
compiles only the reviewed source list, pins the helper's digest/device/inode and
code signature, revalidates that identity before each execution, and carries the
private email plus the bounded value-free attestation over separate inherited
descriptors. The inherited attestation endpoint removes the pathname race that
would otherwise require Node to expose macOS peer-credential APIs. Native tests
exercise the exact build, substitution denial, malformed attestation and process
loss without opening a browser.

The adapter now has a private, process-internal live composition. Its distinct
HTTPS request contract binds the exact claim, Store revisions, Oracle realm,
portal name and URL, and prepared controls. A separate private T007 ledger stores
only hashes, atomically consumes final approval when issuing a short-lived
capability, and durably burns that capability before checking drift or expiry.
The Store writes the account-operation journal before this authority burn and
advances the account to `signup_in_progress` before invoking the reviewed macOS
adapter. The production session factory builds only the checked-in reviewed Swift
sources and accepts no provider or helper override.

This composition is not reachable from the ordinary server or CLI, and the public
transaction continues to admit only its synthetic provider. No automation
capability flag is enabled. Remaining native account scope is real provider
composition for Trusted Fill and any separately authorized real-browser evidence.
The native channel and composition tests prove orchestration and receipt
enforcement without claiming a live browser effect.

Synthetic protected execution now binds job/claim/settings/account revisions
and target URL fingerprint, writes `prepared` before invoking its injected
executor, and preserves account-before-journal stage ordering. Credential
provisioning and portal observation can therefore precede the later journal
stages, and explicit recovery closes those crash windows without inferring
success. The live email-only account-flow provider remains deferred; the
credential-free Store transaction and injected provider boundary are implemented.

## Focused evidence and remaining integration gates

`tests_js/workspace_native_automation.test.mjs` compares an independent disposable
Python Store with native atomic document persistence, including revision conflicts,
email replacement, registry creation/update/list/get, failed-write stability and
public redaction. Additional tests cover lazy reads and exact HTTP payloads.
`tests_js/workspace_native_accounts.test.mjs` compares realm edge cases and account
validation/public projections with the Python authorities. No credentials or
live data are used. The integrated fixture suite exercises the real native
repository and HTTP dispatcher, concurrent Python-free writers, private files,
old-root/missing-document/journal rejection, and unrelated-document preservation.
The account-operation suite covers idle transport parity, status redaction,
real claim handoff evidence, journal identity checks, and unavailable-job
preservation. The synthetic-execution suite covers a successful non-final
lifecycle, verified attention outcome, executor ambiguity, public-provider
denial, privacy, and malformed loopback bindings.
`tests_js/workspace_native_trusted_fill_boundary.test.mjs` covers a value-free
operation packet, exact successful receipt, missing-provider no-op, effect
ambiguity, stale and authority-widening receipts, and replacement-claim
isolation. `tests_js/workspace_native_trusted_fill_composition.test.mjs` covers
the dispatcher-to-boundary composition, exact value-free provider packet,
non-final receipt, one-shot consumption, and unconfigured-server no-op. The
existing reviewed Swift source set remains unchanged.

`tests_js/workspace_native_email_only_account.test.mjs` covers exact Oracle
binding, private-email isolation, durable pre-effect burn, active and verification
outcomes, provider failure, attestation widening, concurrent invocation, public
redaction, and mutation-free pre-effect rejection. It uses only a loopback target
and a synthetic provider; no browser or owner account is accessed.

Typecheck and owned runtime emission are required. The integration owner also
owns source/runtime catalogs, test matrix, HTTP wiring, fixture marker/allowlist,
normal commit/push hooks and broader acceptance. Worker readiness is not final
native activation or migration acceptance.
