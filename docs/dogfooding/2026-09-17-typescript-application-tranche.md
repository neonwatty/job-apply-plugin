# TypeScript application dogfooding tranche

Date: 2026-09-17

Branch: `codex/ts-job-apply-dogfood-tranche-2`

Base: `origin/staging` at `44837dc`

## Scope and safety

This run used the production-packaged Companion, native TypeScript CLIs, and a
fresh native fixture Store beneath an owner-private temporary parent. The
canonical Store was never opened, cloned, or mutated. The job URL used the
reserved `.invalid` namespace, the applicant facts and reusable answers were
fictional, and the resume was the committed `dogfood-synthetic-resume.txt`
fixture.

The run stopped at `awaiting_review`. It did not visit a third-party job site,
create an account, solve a CAPTCHA, handle MFA, submit an application, or mark
the record applied. No owner applicant values were read or recorded.

## Agent Workflows readiness

The requested Agent Workflows skill is not registered in this Codex session and
no callable `workflow` runner is installed. A separate checkout exists at
`/Users/neonwatty/Desktop/workflows`, but its Agent Workflows instruction files
are locally modified relative to its own revision, so it was treated as
untrusted development state and not used. No Workflows configuration, run,
screenshots, replay, or cleanup evidence is claimed. Workflows development
remained frozen.

## Native journey receipt

| Journey | Evidence |
| --- | --- |
| Packaged startup | The production standalone build and locally built native lock provider started a process-owned Companion against the isolated fixture Store. |
| Facts and preferences | A revision-bound profile replacement stored seven fictional facts, per-path `user` provenance, and synthetic work-mode and compensation preferences. |
| Reusable answers | One user answer was stored as accepted. One agent-observed inferred answer entered `pending`, was explicitly reviewed, and became accepted at revision 2. |
| Managed resume | The committed synthetic TXT fixture was imported as the default managed resume. Acquisition and review restart returned the same resume id, revision, content revision, and digest. |
| Safe intake | Native task intake created exactly one canonical job from a deterministic `.invalid` fixture. The managed resume was attached in a separate revision-bound human patch. |
| Lifecycle | The canonical job traversed `saved → needs_info → ready`; the real attempt later traversed `ready → in_progress → needs_info → ready → in_progress → awaiting_review`. |
| Conflict and draft preservation | At desktop width, the Companion kept an unsaved notes draft after a concurrent native CLI company update. `Reapply my draft` adopted the canonical company while preserving the notes, and the saved record reached revision 6. |
| Exact blocker | A claimed attempt handed off one non-sensitive pending answer. The CLI and Companion both showed one `answer-required` information blocker and one missing item for the same revision-bound reference. |
| Desktop/mobile | The blocker and final manual-review state were read through the packaged Companion at the default desktop viewport and at `390×844`. The mobile document measured 390 CSS pixels wide with no page-level horizontal overflow. |
| Resolution | The reusable answer was confirmed, then the exact job, session, answer revisions, and pending reference were owner-confirmed through the native command. The job became `ready` at revision 9 with no pending information. |
| Browser interruption | A local confirmation dialog interrupted the first UI resolution attempt. A fresh browser client read the same unchanged canonical `needs_info` state; resolution then completed through the exact native contract. |
| Claim recovery | A controlled isolated-fixture expiry produced `expired_agent_attempt` with `claim-recover` guidance. Native recovery emitted `claim-recovered` without changing the target job or managed resume identity. |
| Manual-review handoff | The recovered claim supplied a closed Greenhouse readiness fixture with all seven assertions passed, zero blockers, `final-action-untouched`, and `ready_for_owner / final-review-required`. The job became `awaiting_review`. |
| Review restart | With explicit confirmation that nothing had been submitted, native review restart returned the same managed resume identity, advanced the job to revision 12, and a second verified handoff returned it to `awaiting_review` at revision 13. |
| Durable readback | A separate Chrome client and the native activity projection both read revision 13, review step, readiness `ready`, zero blockers, zero pending items, and the complete started/blocked/recovered/restarted/reviewed history. |
| Final-action boundary | History contains no `applied` or `completed` event. The UI exposed `Mark applied` as a human action, and it was not invoked. |

## Findings

No product defect was reproduced in this tranche. The revision-conflict UX,
pending-answer linkage, recovery guidance, review-restart boundary, and manual
final-action boundary behaved as designed.

The in-app browser could not programmatically dismiss the local JavaScript
confirmation after the action was interrupted, and its open dialog also
prevented later interactions in that browser session. A fresh browser client
successfully read the unchanged Store and completed the remaining local checks.
Because the application state was intact and the behavior was specific to the
automation surface's dialog control, this is recorded as an evidence limitation,
not a Job Apply product defect or Workflows-platform result.

## Validation

- `npm ci`: passed with zero reported vulnerabilities.
- `npm run build:runtime`: passed; 223 runtime modules emitted.
- `npm run companion:build`: passed; production standalone assets assembled.
- `PATH=/opt/homebrew/bin:$PATH npm run test:affected -- --base origin/staging`:
  passed all nine selected suites, including TypeScript checks, 167 runner
  assertions, migration inventory, source-size policy, and documentation links.
- Native CLI readbacks confirmed accepted observed-answer revision 2, managed
  resume continuity, exact pending-answer resolution, claim recovery, review
  restart, final job revision 13, and no final-action history event.
- Packaged browser readbacks confirmed desktop conflict handling and mobile
  blocker/manual-review states with no page-level horizontal overflow.
- The adjacent JSON receipt contains only value-free proof flags and counts.

The disposable Companion process, browser tabs, viewport overrides, native lock,
and isolated Store are removed after the final repository checks.
