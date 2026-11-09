# macOS Employer-Account Automation Design

## Status

Proposed for implementation after owner review. This design starts from
`origin/staging` at `0d17bbe` and does not change the plugin version.

## Goal

Make the existing employer-account control plane production-capable for a
disabled-by-default, explicitly approved macOS canary while preserving an
additive platform- and ATS-neutral boundary. Workday is the first
password-bearing implementation. Greenhouse is explicitly represented as an
accountless application flow unless a future, separately reviewed adapter can
prove a distinct account realm and closed control vocabulary.

The implementation must not expose a live account-creation command, activate
an application final action, open a live employer portal, access the owner's
Store or Keychain during development, or create a real account. A live canary
remains a later sequential operation requiring fresh owner approval.

## Current-State Audit

### Production-capable components

- The canonical Store owns revisioned automation settings shared by the CLI
  and authenticated Companion: enablement, automatic account creation,
  password strategy, and one global signup email.
- Each proven employer realm may have a write-only signup email override.
- Workday tenant hosts and Oracle Recruiting tenant/site pairs have strict,
  stable realm normalization. Unknown or ambiguous authorities fail closed.
- Employer-account metadata and a value-free write-ahead operation journal are
  durable. A stranded operation can be reconciled only as ambiguous; recovery
  never infers success.
- Canonical job claims can be handed to Needs Attention with value-free
  blockers.
- The credential-provider contract is platform-neutral and cannot retrieve,
  reveal, copy, export, or return a secret.
- The macOS Security.framework helper generates random passwords, stores them
  in a realm-derived Keychain slot, and returns opaque metadata only.
- The private T007 authority provides domain-separated, hash-only,
  single-attempt approval and durable burn semantics.
- Oracle Recruiting has a private, approval-gated, live-capable email-only
  macOS Accessibility flow with no password or application-final-action
  vocabulary.

### Synthetic-only components and gaps

- The password-bearing executor accepts only the committed loopback HTTP
  portal. Its public CLI route is named `employer-account-execute-synthetic`.
- The native secure-input bridge accepts only the loopback synthetic page,
  clears the password after proving the fill, and cannot activate a real
  Create Account control.
- The reviewed live password-account vocabulary is hard-disabled.
- Capability correctly reports `credentialOperationsReady: false`.
- Same-realm Keychain reuse has isolated test coverage but no production
  Workday execution path.
- Email verification, CAPTCHA, MFA, reset, and ambiguous outcome handoffs are
  exercised through synthetic lifecycle labels, not a reviewed Workday
  observer.
- Greenhouse has no employer-account realm adapter. The supported Greenhouse
  application fixture is accountless, so treating a board URL as a credential
  realm would be unsafe.

## Scope

### Included

1. An ATS-neutral account-flow registry that selects a reviewed flow from a
   proven portal realm and exposes capability without side effects.
2. A Workday password-account flow contract and reviewed macOS native adapter.
3. Explicit Greenhouse accountless classification for the supported board URL
   families, with no credential provider invocation and no account record.
4. Read-only Workday preparation that binds an exact HTTPS tenant realm,
   signed browser identity, page identity, and closed account controls.
5. A disabled-by-default private Workday T007 execution seam that can receive
   the canonical email and realm Keychain password without exposing either.
6. At-most-once Create Account activation, post-effect observation, durable
   lifecycle transitions, and typed human-attention handoffs.
7. Same-realm behavior that skips creation for an active account and reuses
   the exact realm credential slot only for a safely authorized discovered or
   resumable account.
8. Unit, contract, adversarial, crash-recovery, and macOS compilation tests
   that do not require a live employer portal or the owner's Store/Keychain.
9. Documentation that distinguishes production-capable, disabled-canary, and
   synthetic-only behavior.

### Excluded

- Enabling or invoking a live canary.
- A public or model-visible live execution CLI, HTTP endpoint, or Companion
  button.
- Opening a live employer portal, creating a real account, or accessing the
  owner's Store, browser profile, or Keychain.
- Automating login, password reset, email verification, CAPTCHA, MFA, or any
  application final action.
- Generic DOM selectors, JavaScript execution, arbitrary navigation, or an
  extensible action language.
- Windows or Linux credential implementations.
- Claiming that Greenhouse has an account flow not represented by committed,
  reviewed evidence.
- Plugin version changes, installation, promotion, tagging, or release.

## Architecture

### 1. ATS-neutral flow registry

Realm resolution and account-flow selection remain separate. Realm adapters
prove stable identity; flow adapters declare one closed flow kind:

- `password_candidate_account`: Workday tenant realm; credential required.
- `email_only_candidate_profile`: Oracle tenant/site realm; no credential.
- `account_not_required`: reviewed Greenhouse board/application URL; no account
  record, credential, or account effect.
- unresolved: every authority or page shape not proven by a reviewed adapter.

The registry returns only capability metadata. It performs no browser,
Keychain, executable, permission, or network probe. Adding a future ATS means
adding a resolver and a flow adapter; Store, approval, and recovery contracts
must not branch on hostnames outside the registry.

Greenhouse accountless classification is intentionally narrow. It establishes
only that the reviewed application path does not require employer-account
automation. A login, candidate-home, or unknown Greenhouse surface remains
unresolved and produces human attention.

### 2. Shared canonical settings

The existing Store remains the sole source of truth. CLI and Companion continue
to use the same revisioned record. The global signup email remains write-only
in public projections, and a realm override wins only for that exact realm.
Password values never enter these records.

The implementation will add a value-free flow decision projection so callers
can learn `create_required`, `reuse_active`, `account_not_required`, or
`human_attention_required` without receiving a URL, email, password, Keychain
identifier, or browser state.

### 3. Workday read-only preparation

Preparation runs before final approval and cannot make any page change. The
reviewed native helper independently verifies:

- the running browser is the exact allowlisted signed Safari or Chrome binary;
- the visible page is the exact query-free HTTPS Workday tenant URL whose
  tenant/cell descriptor matches the canonical realm;
- one account form contains exactly one reviewed email control, one secure
  password control, and one Create Account control;
- no unknown required or actionable controls are present;
- control roles, labels, parentage, enabled state, and stable fingerprints
  match the reviewed Workday vocabulary.

Preparation returns value-free fingerprints only. Canonical job, claim,
settings, account, portal, and control fingerprints are bound into a stable
approval scope. Preparation approval and final execution approval remain
separate one-shot capabilities.

### 4. Private Workday execution seam

The final seam is process-internal and disabled by default. It is not reachable
from Store CLI, Companion HTTP, ordinary job-apply skill instructions, or a
generic browser tool. A later owner-approved canary runner must supply the exact
stable scope and consume a fresh T007 capability.

Execution order is fail-closed:

1. Revalidate the canonical job, live claim, exact realm, settings revision,
   account revision, and prepared control fingerprints.
2. Write the value-free account-operation journal.
3. Durably consume the one-attempt T007 capability.
4. Mark the account `signup_in_progress`.
5. Give the canonical email to the native helper through a private inherited
   descriptor.
6. Ask the macOS credential provider to provision or reuse the exact
   realm-derived Keychain slot and deliver the password directly to the exact
   secure control.
7. Reattest email and password controls, then activate the exact Create Account
   control once.
8. Reobserve without repeating any effect and classify the causal successor.
9. Persist the lifecycle result, hand off if necessary, and clear the journal.

Any exception after the journal write becomes `ambiguous`, permanently denies
automatic retry, and produces a Needs Attention handoff. Process interruption
leaves the journal for explicit recovery.

### 5. Secret-safe native delivery

Email and password bytes remain native and ephemeral:

- Email crosses only a private inherited file descriptor owned by the reviewed
  helper process.
- Password bytes are generated or retrieved inside Security.framework code and
  passed directly to the Accessibility secure-input boundary.
- Neither value appears in argv, environment variables, stdin/stdout, JSON,
  HTTP, DOM scripts, pasteboards, logs, exceptions, Store files, approvals,
  activity, or receipts.
- The helper zeroes temporary password buffers and closes the email descriptor.
- Python receives only opaque credential reference/version, reuse status, and
  value-free native attestations.

The Keychain service namespace remains adapter-owned. `unique_per_realm`
derives exactly one slot per realm reference. `shared`, `custom`, and
`ask_each_time` do not gain live Workday authority in this slice; they route to
human attention. This narrows the production seam to the requested safe
default.

### 6. Lifecycle and human attention

The native observer returns one value-free outcome from a closed set:

- `active`
- `email_verification_required`
- `captcha_required`
- `mfa_required`
- `password_reset_required`
- `failed_definitive`
- `ambiguous`

Canonical account lifecycle may continue to group verification challenges
under `verification_required`, while the session blocker preserves the typed
reason. The Store maps these outcomes to durable blocker codes without copying
page text:

- email verification -> `email-verification-required`
- CAPTCHA -> `captcha-required`
- MFA -> `mfa-required`
- reset -> `owner-input-required`
- unknown or interrupted state -> `browser-state-uncertain`

All non-active outcomes release the live claim through the existing
coordinator and move the exact job to Needs Attention. No verification,
CAPTCHA, MFA, or reset step is attempted by automation.

### 7. Same-realm reuse

An active canonical account for the exact realm produces `reuse_active` and
skips account preparation, Keychain access, and Create Account activation.
The application flow may continue to its ordinary visible login/application
handling, which remains outside this slice.

Before an account is active, the provider may reuse an existing Keychain item
only when its opaque reference equals the deterministic reference for
`unique_per_realm` and the canonical realm/account revisions still match. A
different realm can never reuse that slot. Ambiguous, verification-required,
reset-required, and definitive-failure records are terminal for automatic
creation and require owner resolution.

### 8. Future platforms and ATS adapters

Portable Python protocols own request and receipt validation. The macOS module
is only a registered implementation. Windows Credential Manager and Linux
Secret Service adapters can later implement the same compound
provision/reuse/fill contract without changing Store records or public CLI
settings.

ATS adapters own realm proof, reviewed controls, and outcome classification.
No generic fallback may convert an unknown hostname, employer name, form label,
or job URL into a credential realm. Future ATS support therefore requires an
explicit adapter plus adversarial fixtures and review.

## Data and Interfaces

New public projections are value-free. Proposed core interfaces are:

```python
class EmployerAccountFlowAdapter(Protocol):
    adapter_id: str
    flow_kind: str

    def classify(self, portal_url: str) -> dict: ...

class PasswordAccountAutomationProvider(Protocol):
    provider_id: str

    def prepare(self, request: dict) -> dict: ...
    def execute(self, request: dict, private_email: Callable[[], str]) -> dict: ...
```

`prepare` returns exact value-free component fingerprints. `execute` returns
only provider identity, opaque credential metadata, reuse state, closed
outcome, at-most-once activation count, and secret-removal attestations.

The existing account record remains compatible. Typed handoff reason codes are
stored only in the value-free session blocker. No migration is needed for
existing records; missing new optional outcome detail is interpreted as the
existing conservative generic state.

## Error and Recovery Semantics

- Invalid or unsupported realms fail before Store mutation.
- Greenhouse accountless classification creates no employer-account record.
- Revision, claim, portal, browser, control, provider, and approval drift fail
  before native effects.
- Failure before the journal write is retryable only by starting a newly
  approved operation.
- Failure after the journal write is ambiguous and not automatically retryable.
- Failure after creating a new Keychain item but before a proven browser fill
  deletes that newly created item; reused items are never deleted.
- Failure after either field fill begins is ambiguous even if the page appears
  unchanged.
- Create Account is never activated more than once. Observation may poll, but
  effects may not retry.
- Recovery converts a stranded operation to ambiguous, hands off the same live
  claimed job when possible, and clears only the matching journal entry.
- Diagnostics use stable stage/reason codes and never include native exception
  text or applicant data.

## Testing Strategy

All production changes follow red-green-refactor.

### Portable and Store tests

- Resolver tests for exact Workday realm stability, narrow Greenhouse
  accountless paths, and ambiguous/credential-bearing URL rejection.
- Flow-decision tests for create, active reuse, accountless, and human-attention
  states.
- Request/receipt validation tests for unsupported fields, revisions,
  fingerprints, provider identity, and forbidden final actions.
- Store tests for settings and overrides, active-realm no-op reuse, exact
  realm credential reuse, typed blockers, terminal states, one-winner
  concurrency, and value-free serialization.
- Crash matrices around journal write, authority burn, lifecycle transition,
  Keychain provider entry, field effects, activation, observation, handoff, and
  journal clear.

### Native tests

- Source-contract tests prohibit argv/environment/pasteboard/HTTP/JavaScript
  secret channels and generic action vocabulary.
- Swift typechecking for the complete reviewed source set.
- Pure adversarial fixtures cover wrong browser/page/realm, extra controls,
  duplicate controls, hidden/disabled controls, wrong secure control,
  fingerprint drift, successor ambiguity, and every lifecycle classification.
- Existing visible synthetic browser and isolated runner-Keychain tests remain
  behind their explicit macOS CI gates.

Local verification must not run the Keychain-mutating integration test or any
visible-browser test under the owner account. The PR's macOS runner may run
isolated Keychain/browser verification using its existing explicit CI opt-ins.

## Documentation and Product Truthfulness

The README, job-apply skill, Companion copy, and capability output must agree:

- Settings and recovery are production-capable.
- Greenhouse's reviewed application flow is accountless.
- Oracle email-only and Workday password-account native seams are private and
  disabled pending an explicitly approved live canary.
- The public account executor remains synthetic-only.
- Ordinary job application flows continue to pause for login, account creation,
  email verification, CAPTCHA, MFA, password reset, and final submission.

No documentation may claim successful real-account creation without a later
owner-approved live canary and its separately reviewed evidence.

## Delivery

Implementation will remain on `codex/macos-employer-account-hardening`, be
verified without owner Store/Keychain/live-portal access, and be proposed as an
unmerged pull request into `staging`. CI will be monitored and the exact head,
checks, skipped local gates, and remaining production limitations will be
reported. The branch will not be merged, installed, versioned, promoted,
tagged, or released by this workstream.
