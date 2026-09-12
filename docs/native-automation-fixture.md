# Native automation and employer-account control plane

This tranche supplies native settings, realm resolution, and employer-account
registry services, stranded account-operation recovery, and injected synthetic
protected-account execution for explicit fixtures. It does not activate a Store
writer, initialize an existing Store, inspect the owner's browser, or call the
owner's credentials. New fixtures use version 11 and require both account
documents plus `account-operation-journal.json`. Existing version 10 roots are rejected rather than upgraded or adopted;
earlier fixture documents describe their historical version. Missing documents
and unsupported trusted-fill journals remain rejected.

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

It returns a response or null for an unowned route. The composing HTTP boundary
retains the existing safe request/storage error envelope and revision-conflict
status mapping through `jobsHttp`. All mutation/detail responses use public projections. The Python
GET `/api/automation` aggregate also includes provider capability discovery;
that endpoint is deferred until its truthful native capability contract is
integrated. There are no invented settings-list or account-list GET endpoints.

## Follow-on dependency map

Python authorities remain read-only:
`scripts/job_apply_store/domains/accounts/{settings,registry,trusted_fill,synthetic,operations}.py`,
`scripts/job_apply_store/validation/accounts.py`, `scripts/job_apply_accounts.py`
and `scripts/job_apply_trusted_fill.py`.

Trusted-fill approval needs a live claimed in-progress job, proven realm,
managed-resume identity/content revision and preflight observation, canonical
profile revision, accepted answer bindings, settings/account revisions, policy
revision, and time/expiry. Approval/revocation persists `trusted-fill.json` with
approval revisions. Evaluation may perform an attention handoff through the
coordinator journal, session and application history. It is not a read-only
boolean permission check. These dependencies need a shared transaction boundary
before approve/evaluate/revoke routes can be implemented.

Synthetic protected execution now binds job/claim/settings/account revisions
and target URL fingerprint, writes `prepared` before invoking its injected
executor, and preserves account-before-journal stage ordering. Credential
provisioning and portal observation can therefore precede the later journal
stages, and explicit recovery closes those crash windows without inferring
success. The distinct email-only account-flow provider remains deferred.

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

Typecheck and owned runtime emission are required. The integration owner also
owns source/runtime catalogs, test matrix, HTTP wiring, fixture marker/allowlist,
normal commit/push hooks and broader acceptance. Worker readiness is not final
native activation or migration acceptance.
