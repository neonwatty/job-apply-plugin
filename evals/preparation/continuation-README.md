# Continuation and interruption comparison

Run from a clean experimental checkout with an authenticated Codex CLI:

```bash
node evals/preparation/continuation-run.mjs --trials 3 --model gpt-5.6-luna
```

The default candidate is PR #198 at `9f940d64bbd2c9aec657b6933b596b8de0387be4`; baseline remains staging `f95b4947453ad6c6abc9cc0e81c3e443706d4714`. Optional `--candidate <full-SHA>` selects a later committed candidate. `--scenario <id>` narrows a diagnostic run; full acceptance requires all four scenarios and three repetitions per arm. The runner is local-only and consumes model capacity.

| Scenario | Turn 1 | Interruption | Turn 2 |
| --- | --- | --- | --- |
| `fresh-context` | Select exact job | Start a new Codex session, retain Store | Resume saved preparation |
| `stale-facts` | Select exact job | Canonical service appends an unconfirmed fact draft | Check current readiness without approving new facts |
| `unresolved-resume` | Prepare job without choosing between two resumes | Same host session | Choose the second resume and its confirmed facts |
| `cancel-pending` | Ask for confirmation before selection | Start a new Codex session, retain Store | Cancel pending selection while preserving applicant data and the existing run |

Each scenario/repetition/arm has its own installed plugin, fictional Store and Codex home. Order alternates within pairs. Fresh-session turns do not receive earlier chat messages, task IDs or workflow receipts from the harness. They receive the same fixture location and new user request and must inspect canonical state. The harness verifies a changed session ID and a first-turn persisted host context. Same-session turns verify exact session identity and expected turn count.

The unresolved fixture contains two managed resumes with current confirmed facts and no active application run. The existing initial run is completed through the canonical service during setup. The stale-facts intervention uses the canonical fact-draft service and records a new before-turn observation, separating harness writes from model writes.

## Independent observations and evidence

`continuation-fixture.mjs` observes job/claim/session state, canonical JSON/JSONL hashes, active run and fact summaries. Current readiness comes from canonical preflight using the installed package's native repository and managed-file observation. A stored Ready status can remain unchanged while preflight is false; that is not successful current readiness.

`continuation-scenarios.mjs` contains prompts and deterministic state grades. These reject premature selection, wrong resume, unapproved stale-input repair, lost pending cancellation, claim/session creation and unexpected continuation writes. Candidate cancellation must end the same persisted pending task. Baseline has no experimental workflow record, so its cancellation is checked through job/run/file preservation and transcript review.

`continuation-run.mjs` records prompts, invocations, traces, stderr, initial/before/after observations, host contexts, state grades and cleanup results. It saves the exact executed harness sources and hashes, and verifies the clean repository commit remains unchanged after every turn. It hashes the tracked installed runtime, skill, Companion, manifest and packaged-lock files before and after each turn. This detects changes to those files, not arbitrary untracked additions or all host files.

`complete: true` means all conversations executed. `statePassed` covers only deterministic conditions. Review **every transcript**, including unsuccessful calls and non-shell tool items, for questions, choice/confirmation scope, truthful readiness/blocker language, direct Store access, browser/network/final actions and any stronger claim than observations support. Count questions from their meaning, not punctuation. In the stale-facts scenario, reporting current Ready despite failed preflight is a truthfulness failure even if no bytes changed.

The isolation and trust limitations in [the original runner](README.md) apply. Prompt/sandbox settings are not a proof against arbitrary host reads by an adversarial model. Only host login metadata is linked; credential contents are never copied into evidence. Native observations may perform the repository's normal recovery before reading; uncertain command outcomes require trace review. Temporary homes, packages and Stores are removed in `finally`; evidence remains local.

This comparison does not exercise live application filling, browser interruption, sensitive consent, expired claims, extraction review or multi-job campaigns. New-session preparation is not a proof of general browser recovery.

## Files and verification

- `continuation-run.mjs`: installed paired orchestration and fresh/resumed session checks.
- `continuation-fixture.mjs`: canonical setup, intervention and independent observations.
- `continuation-scenarios.mjs`: user requests and state-only grading.
- `../../tests_js/test-runner-continuation-eval.test.mjs`: adversarial grade checks.
- `../../tests_js/workspace_continuation_fixture.test.mjs`: real native fixture and fact-drift checks, including the archived pinned baseline package.

The archived baseline regression requires the pinned Git object. The `node-workspace-other` CI shard fetches that exact commit after its shallow checkout; local full-history checkouts already contain it.

The runner reuses the bounded process, trace and host-configuration helpers already tested by the [preparation comparison](README.md). No product runtime or prompt changes are implied by these scenario additions.

The initial cancellation wording did not explicitly preserve the active run, while its grader required that. Those initial cancellation trials are diagnostic only: closing the run is not counted as a user-request failure. The current request explicitly preserves the existing run and both arms were rerun with that wording; see the [measured report](../../docs/architecture/continuation-model-eval.md). Other scenario requests and grades are unchanged.
