# Skill cleanup and Companion acceptance

This change follows the September 4, 2026 [skills and prompts audit guidance](https://x.com/pvncher/status/2095991462416490862). Skill roots route by task; detailed storage, browser, platform, replay, and canary protocols load only when relevant. Modernization contracts and manual application submission remain unchanged.

## User-visible behavior

| Request or event | Expected agent and Companion behavior | Verification |
| --- | --- | --- |
| Search with criteria but no saved preferences | Search directly; ask only for consequential missing criteria | Skill walkthrough; empty preference Store remains valid |
| Change one preference | Apply the specified change, preserve other facts, show the canonical result in Facts | `test_job_apply_workspace_search_handoff.py` and existing profile conflict tests |
| Search across sources | Explicit filters, unknowns visible, newest first by default, no numerical suitability score | Skill walkthrough; source observations remain necessary at execution time |
| Select any returned job | Preview only selected items; commit the confirmed preview to Saved, without starting an application | CLI-to-Companion integration in `test_job_apply_workspace_search_handoff.py` |
| Import a current unscored report | Preserve role/company identity and existing report compatibility | `test_store_jobs_legacy_1.py` |
| Missing answer | Preserve the draft, resolve through canonical Answers, then reacquire the same job/resume | Existing pending-answer browser journey in `workspace_answers.test.mjs` |
| Known answer cannot be entered | Browser action required; do not ask the owner to re-enter it in Answers | Existing field-persistence and handoff contracts |
| Non-final Review navigation | Advance to the review page, verify readiness, persist awaiting_review, leave submission to the owner | Existing task/attempt/readiness tests and routed browser instructions |
| Extraction request | Agent fulfills the exact request; owner reviews proposals in Facts/Resumes | Existing onboarding and skill/Companion contracts |

Narrative walkthroughs check instruction consistency; they are not claims of autonomous live ATS or search testing. Search behavior is agent-directed, so deterministic API tests cannot establish that a model will follow every instruction on a live website.

## Verification and packaging

`python3 -m unittest tests.test_skill_documents` checks reachable references and missing or escaped targets. Existing documentation contracts now read the skill's reachable references instead of requiring all detail in its root. Runtime agents must not eagerly concatenate references.

The final-action checker follows application references. Installed-package byte receipts cover the complete `skills/` tree, with a regression test for missing or stale reference bytes. The affected-test matrix now routes skill changes to agent, Companion, replay, and packaging checks as well as link checks.

Use the repository's affected/full and release tiers for validation. Disruptive owner-browser/native account canaries are outside this cleanup and retain their explicit opt-in. No production application or Store schema changes are required.

Global installed-plugin removal or deduplication is separate from this repository change.
