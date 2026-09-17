# TypeScript dogfood Phase C: Automation/ATS and Trash boundaries

Date: 2026-09-17  
Base: `origin/staging` at `6659c003afe0a4ef2d19e6ae44154fccbbf41c50`  
Branch: `codex/ts-job-apply-dogfood-phase-c`

## Scope and safety

Phase C used a new native fixture rooted at `/private/tmp/job-apply-ts-phase-c.6qnEvB/store`. It did not reuse either earlier dogfood Store. Every profile, email, resume, answer, employer, portal, and job value was synthetic. No third-party portal was opened, no account or credential was created, no CAPTCHA or MFA was attempted, and no Submit, Send, Apply, or equivalent final action was activated.

The locally present Agent Workflows development checkout is not a trusted installed runner and remains separately blocked as an infrastructure prerequisite. It was not modified, invoked, or cited as evidence. Direct isolated product dogfooding continued without it.

## Focused defect and failing-first proof

Companion correctly rejected an unsupported Greenhouse portal without adding an account record, but displayed the internal Store message `employer account realm is unresolved`. The browser regression was added first and failed after 30 seconds waiting for the required actionable copy. The fix maps only that exact `store_rejected` response in the Add portal flow to:

> This portal is not supported for account preparation. Add an exact Workday or Oracle Recruiting job URL.

The production Companion browser suite then passed and independently verified that the account registry remained empty after rejection before adding a supported Workday realm.

## Automation and ATS journey

| Boundary | Evidence |
| --- | --- |
| Realm classification | The native resolver classified synthetic Workday as `password_candidate_account` with `credentialRequired: true`, Oracle Recruiting as `email_only_candidate_profile` with `credentialRequired: false`, and both Greenhouse and an unknown host as `adapter_unresolved`. No unresolved account record was created. |
| Honest capability status | Companion displayed `Workday setup unavailable`, `Greenhouse status unresolved`, `Oracle setup unavailable`, and `Live actions off`. The native capability reports no composed live provider. Greenhouse accountless classification is therefore recorded as unavailable on the public boundary, not fabricated. |
| Supported portals and settings | Companion added exact synthetic Workday and Oracle URLs. Public readback showed two redacted realms, per-realm email configuration flags, Workday credential metadata unprovisioned, and Oracle explicitly password-free. Global settings reached revision 3 with account preparation enabled, protected preparation enabled, `unique_per_realm`, and a configured-but-hidden synthetic email. |
| Revision conflicts | A concurrent settings update advanced revision 1 to 2; the stale UI save reported that nothing was retried. A fresh client read the canonical `ask_each_time` change before a reviewed revision-3 update. A concurrent Workday override clear advanced the realm from revision 1 to 2; the stale UI save reported no retry and the restarted client retained revision 2 with the global email setting. |
| Trusted Fill approval | Companion approved one exact revision-3 Workday packet for only `fill_text` and `select_option`, using three explicit fingerprints. Status readback was value-free and showed active approval revision 1. The ordinary server refused evaluation because no native provider was composed and did not consume the approval. |
| Trusted Fill closed boundary | Focused native suites proved exact one-shot non-final execution, value-free receipts, missing-provider no-op, replay burn, resume drift, stale/mismatched bindings, widened/final receipts, claim replacement isolation, and Needs Attention handoff after ambiguity. |
| Account lifecycle boundary | Focused suites proved credential-free Oracle success and verification handoff, password-account synthetic success and ambiguity handoff, malformed binding rejection before effect, and explicit stranded-operation recovery without retry. Credential, CAPTCHA, MFA, verification, reset, and final-action controls remain outside automation. |
| Restart durability | Companion was stopped and restarted twice. A fresh client retained settings revision 3, both realm records, the active revision-1 approval, the exact in-progress job, and the value-free application state. The reopened browser no longer possessed the claim credential and offered no implicit recovery. |

## Trash and destructive journey

Three independent records were created: a saved job, a non-default unreferenced managed resume, and a confirmed unreferenced answer. CLI trash produced one redacted row of each type; Companion showed exactly `1 jobs · 1 resumes · 1 answers`. Each record was restored through the UI and canonical Trash returned to zero.

Negative checks preserved canonical state:

- trashing the actively claimed Workday job failed with the coordinator-ownership blocker;
- trashing its default, referenced resume failed with the active-job reference blocker;
- the browser suite rejected stale revisions without retry, required the exact per-type phrases `DELETE JOB`, `DELETE RESUME`, and `DELETE ANSWER`, and isolated each requested record;
- focused lifecycle suites proved default/reference/duplicate and nonterminal-session blockers, expired-claim precedence, no automatic conflict retry, managed-file removal on permanent resume deletion, and retained job history/session evidence after permanent record deletion;
- private URLs, notes, answer values, resume paths, claim credentials, and signup emails were absent from Trash and public automation projections.

The production browser journey permanently deleted only its own disposable fixture records. The Phase C evidence Store was later moved intact to macOS Trash rather than permanently erased.

## Browser and validation evidence

- Production standalone Companion browser suite: passed after the fix. It covered the unsupported-portal regression, desktop and 390px Automation layout, job/resume/answer restore and permanent delete, exact phrases, stale conflicts, reference privacy, managed-file deletion, and Python-free native CLI sharing.
- Manual Companion at desktop width: supported realms, settings conflict, Trusted Fill approval/status, Trash counts, and restore flow verified.
- Manual 390×844 checks: both Automation and Trash reported `innerWidth: 390`, `scrollWidth: 390`, and no document overflow. The viewport override was reset afterward.
- Focused Automation/ATS boundary suites: 31 tests passed.
- Focused Trash/lifecycle suites: 99 tests passed.
- `npm run companion:build`: passed.
- `npm run test:affected -- --base origin/staging`: 23 of 25 selected suites passed, including migration inventory, production Companion browser coverage, and all 1,897 `node-workspace-other` assertions. The two local host-baseline suites failed outside the changed surface: `native-frozen-reference-profiles` rejected the installed unreviewed CPython 3.12.14 patch, and `native-posix-lock` could not compile against the current Xcode toolchain because `sys/file.h` was unavailable. These are recorded as local environment limitations; canonical PR CI remains the merge gate.

No application-completion or applied event was written. The synthetic job remained `in_progress`; final action authority remained false/unavailable throughout.
