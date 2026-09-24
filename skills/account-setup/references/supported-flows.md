# Supported account flows

Use the classifier result as the source of truth. The labels below explain what to do with a recognized result; they do not duplicate URL recognition.

| Classified adapter | Required handling |
| --- | --- |
| `workday` / `password_candidate_account` | An account is required for the tenant-host realm. With the user's request, save only the redacted realm metadata. Explain that password setup and use remain user-controlled and macOS Keychain-only. Never accept a password or claim native/browser readiness from the saved record. |
| `mygreenhouse` / `passwordless_email_code` | The single global record is optional. Create it only when the user explicitly wants MyGreenhouse represented. It stays provider-free and credential-free; the user handles the browser-delivered email code. |
| `oracle-recruiting` / `email_only_candidate_profile` | An account is required for the tenant-site realm, but there is no credential provider. Save only redacted realm metadata when requested. The user supplies identity and completes any email confirmation in the ATS. |
| `greenhouse` / `account_not_required` | A direct Greenhouse application needs no account record. Do not create or persist one; return to the application workflow. |

## Inspect before mutation

List public saved metadata before deciding whether a resolved realm needs a record:

```bash
node "<plugin-root>/apps/companion/command.mjs" store employer-account-list
```

The classification and list outputs are deliberately redacted. Treat opaque realm identifiers only as revision targets returned by these commands; never substitute a credential reference or a descriptor from a private file.

## Create only the classified record

For a resolved Workday or Oracle realm, or an explicitly requested optional MyGreenhouse record, use the exact classified URL without an input payload:

```bash
node "<plugin-root>/apps/companion/command.mjs" store employer-account-create --url "$portal_url"
```

Do not create on `account_not_required`, unresolved, ambiguous, or rejected results. An already-existing error is not a reason to overwrite it; inspect the public list instead.

The CLI account-update payload changes only an email override, so this value-free skill never invokes it. Direct the user to Companion's **Accounts & Sign-in** workspace when they ask to clear existing contact metadata or remove a saved record. That authenticated workspace uses exact revisions and the canonical HTTP mutations; it does not collect or set a contact email, establish a live browser session, or infer sign-in success. Do not reproduce those mutations with hand-built HTTP calls or capture its session.

## Report readiness truthfully

Report these dimensions independently:

- classification: recognized adapter and flow, or the value-free unresolved reason;
- configuration: whether redacted metadata is saved and its public revision;
- browser session: observed or not observed by Companion;
- native execution: available only when the public capability says so.

For Workday, a saved realm with Keychain setup pending is configured but not native-ready. For MyGreenhouse and Oracle, provider-free is the expected contract, not a missing password. Direct Greenhouse remains account-free and unpersisted.
