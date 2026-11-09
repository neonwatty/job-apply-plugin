---
name: account-setup
description: Inspect or configure Job Apply account and sign-in metadata for a supported ATS portal without handling credentials or verification codes.
allowed-tools: Read, Bash
---

# Account Setup

Resolve account and sign-in readiness through the shared Store contract. This skill configures redacted local metadata; it does not sign in, create an account on an ATS, or prove that a browser session is ready.

## Start from the canonical contract

Read [answer-memory](../answer-memory/SKILL.md) to resolve `<plugin-root>`, initialize the Store, and follow its private-file and revision rules. For a first-use or cross-skill handoff, read the shared [workflow map](../answer-memory/references/workflow-map.md).

Use only the packaged router:

```bash
node "<plugin-root>/apps/companion/command.mjs" store account-flow-classify --url "$portal_url"
```

Classify the exact HTTPS portal or application URL supplied by the user. Route on the returned `status`, `adapterId`, `flowKind`, and `accountRequired`; do not recreate hostname or path matching in prose or shell. An unresolved classification is a stop, not permission to guess or persist a record.

After classification, read [supported account flows](references/supported-flows.md) for the matching adapter and mutation rules.

## Keep values and authority out of this workflow

Never request, read, copy, print, transmit, or persist passwords, email values, one-time codes, recovery data, raw credential references, cookies, tokens, or browser secrets. Do not use an email value already visible elsewhere. Workday credentials remain exclusively in macOS Keychain and user-controlled native setup. Passwordless MyGreenhouse never gains a password or credential-provider record.

Use public redacted Store results only. Never read Store files directly or call authenticated Companion HTTP routes with hand-built session data. The Accounts & Sign-in workspace owns revision-safe clearing and removal controls and displays browser-session readiness separately; it does not establish or infer a live session. A revision conflict requires a fresh inspection and user review; never retry blindly.

Persisted configuration, portable classification, and native execution readiness are separate facts. A saved account record is not evidence of an active browser session, a usable credential, or authority to operate a live ATS. Leave sign-in, account creation, email-code entry, CAPTCHA, MFA, legal consent, and recovery to the user.

When setup is complete or deferred, hand ordinary application work back to [job-apply](../job-apply/SKILL.md). This handoff does not grant browser-fill or final-action authority.
