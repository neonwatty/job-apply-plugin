# Python Release Employer-Account Automation

## Status and boundary

This is the implementation contract for the Python release lane. It supersedes
the staging-target assumptions in the 2026-09-02 design without importing or
merging the TypeScript runtime. Development and automated verification use only
temporary Stores, synthetic portals, and non-disruptive native compilation.

No live Workday support may be claimed until the reviewed adapter and a bounded,
freshly owner-approved canary both pass. No visible-browser, native Keychain, or
real-account test is authorized by this document. Final application submission
always remains manual.

## Audit receipt

- Canonical settings are revisioned and already support a write-only global
  signup email plus an exact write-only employer-realm override.
- Workday realm identity is tenant/cell scoped; Oracle identity is tenant/site
  scoped. Unknown, shared-gateway, credential-bearing, and ambiguous URLs fail
  closed.
- Employer records persist opaque provider/reference/version metadata only. The
  account-operation journal is value-free and interruption recovers to ambiguous.
- The macOS Keychain helper generates or reuses password bytes within the native
  boundary and returns metadata only. Its current shipping Workday call is fixed
  to version 1 and `unique_per_realm`.
- Oracle has a reviewed, approval-gated email-only adapter. Workday has reviewed
  code and synthetic fixtures, but no accepted real canary.
- CAPTCHA, MFA, email verification, reset, ambiguity, and unsupported controls
  already map to typed Needs Attention handoffs. Final submission is not in the
  account vocabulary.
- Companion settings are authenticated and write-only for email, but the prior
  Workday capability copy treated “adapter present” as “ready” and exposed two
  overlapping legacy human-managed strategy labels.
- Existing isolated-worker inputs can safely carry the public outputs of
  `automation-settings-get` and `automation-capability`; neither contains email,
  credential, realm, descriptor, browser, or Store-path material. Workers must
  never copy automation-settings.json or employer-accounts.json.

## Product contract

The canonical strategies are:

1. `unique_per_realm`: one macOS Keychain slot per exact employer realm.
2. `shared`: one versioned Keychain slot shared only by compatible employer
   portals. It is unavailable until native secure setup exists.
3. `manual`: the owner creates or manages the account. No credential provider is
   invoked. Legacy `custom` and `ask_each_time` settings remain readable and
   project as `manual`.

Password entry, generation, and rotation must be native macOS operations. Secret
bytes may never cross argv, environment, stdin/stdout, JSON, HTTP, Store,
Companion, logs, receipts, pasteboard, DOM script, or agent-visible channels.

Credential references are deterministic opaque slot identities. Version 1 must
retain its historical identity. A rotation derives a new positive-version slot;
existing employer records stay pinned to their stored reference/version until an
explicit owner-approved account update succeeds. Rotation never rewrites all
accounts and never implies a password reset succeeded on a third-party portal.

## Capability and ordinary application behavior

Capability distinguishes code presence from product readiness:

- `workdayPasswordAccountAdapterReviewed` may be true from static reviewed code.
- `workdayCanaryPassed` remains false until external reviewed evidence exists.
- `workdayPasswordAccountReady` is true only when both the adapter and canary
  gate are satisfied for the selected strategy.
- Each strategy has a closed state and reason code. Manual is always described as
  owner-managed, not unavailable automation.

Oracle and Workday decisions compose with the ordinary Python job claim/session
flow. Any CAPTCHA, MFA, verification, legal consent, ambiguity, unsupported ATS
page, or missing capability produces a typed handoff and releases the claim. No
account approval authorizes applicant-data consent or a final application action.

## Isolated-worker configuration

Provision a worker with only the JSON outputs of `automation-settings-get` and
`automation-capability --platform <platform>`, plus its normal job package.
Never copy raw Store documents or Keychain material. A worker treats
`signupEmailConfigured` as a boolean and obtains the actual email only through the
canonical private execution boundary after approval. Store roots, credential
references, account descriptors, and email values are not provisioning inputs.

## Reviewable implementation slices

1. Canonicalize manual strategy projection, add version-aware opaque slot
   derivation, export honest per-strategy capability, update Companion language,
   and prove redacted worker configuration using existing CLI contracts.
2. Add a native secure shared-password setup/rotation tool and value-free receipt.
   This slice requires security review but no live portal.
3. Bind shared versions and deliberate per-account upgrades into Store journals;
   keep existing accounts pinned and all reset/update outcomes typed.
4. Integrate the reviewed Oracle/Workday decisions into ordinary application
   orchestration, then run synthetic and adversarial regression tiers.
5. With fresh owner authorization only, run one bounded Workday canary and review
   its value-free evidence before changing the readiness gate.

## Slice 2 implementation receipt

The reviewed macOS shared-credential tool is a standalone native boundary. Setup
creates version 1; rotation requires an explicit version of 2 or greater. Both
paths use atomic Keychain creation and reject an existing slot rather than
updating it. The owner may request native random generation or type into an
AppKit secure field whose copy, cut, and paste key equivalents are disabled.

The Python launcher passes only action, source mode, and version to the native
process. Successful output contains only the opaque reference, positive version,
and `created` status. Cancellation, an existing version, build failure, and every
other failure are value-free and fail closed. This slice does not update employer
records, claim a portal password reset, enable shared Workday automation, or run
a native Keychain/visible-browser test.

## Slice 3 implementation receipt

The canonical Store can now pin a discovered Workday account to one explicit
owner-created shared credential version. The binding is revision-checked,
owner-confirmed, and journaled before account metadata changes. It contains only
the deterministic opaque reference and positive version; the Store never checks,
reads, receives, or creates the Keychain value.

An active account remains pinned when a later shared version is created. A
separate owner-confirmed begin operation burns a value-free
`reset_in_progress` journal entry for exactly one account, source version, and
higher target version. Completion accepts one closed observed outcome. Only
`updated` advances the opaque reference/version and retains `active`; CAPTCHA,
MFA, email verification, reset-required, definitive failure, and ambiguity keep
the source binding and move the lifecycle to the matching closed state. An
interrupted upgrade recovers to `ambiguous` without changing the version.

These Store commands do not operate a browser, reset a third-party password, or
prove that a shared slot exists. Shared live Workday execution therefore remains
unavailable with `shared_native_execution_required` until its separate native
execution integration and canary are reviewed.

## Migration follow-up

The TypeScript lane must independently port the normalized strategy projection,
version-1 reference compatibility, rotation pinning, capability vocabulary,
redacted worker package, and Companion wording. It must use cloned Stores during
differential testing and must never write the Python release Store.
