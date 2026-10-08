# Preparation discovery and input guidance

Slice 4e responds to the [continuation comparison](continuation-model-eval.md). It remains an explicitly scoped fictional-Store experiment, stacked on PR #199. The plugin manifests, host entry points and persisted task/run schemas remain unchanged.

## File map

| File | Responsibility |
| --- | --- |
| `src/contracts/workspace/application-run-inputs.ts` | Shared current resume/fact/file guard for run execution and advisory inspection |
| `src/workspace-core/application-runs.ts` | Existing run mutation calls the shared guard inside its canonical transaction |
| `src/app/preparation-guidance.ts` | Read-only discovery, blockers, candidate input metadata and existing-command descriptors |
| `src/app/preparation-selection.ts` | Explicit type for the unchanged selection projection |
| `src/app/preparation-workflow.ts` | Compose guidance with current task/context in one Store transaction |
| `src/workflows/applications/prepare.ts` | Code-defined question and confirm/decline outcomes |
| `src/cli/experimental-workflow.ts` | Return the question presentation with accepted/replayed ask receipts |
| `skills/job-apply/references/experimental-workflow.md` | Explain guidance consumption, explicit input authorization and accurate confirmation wording |
| `tests_js/workspace_preparation_guidance.test.mjs` | Ambiguity, current references, drift, revocation, cross-job/stale pending scope, file failures and byte preservation |
| `tests_js/workspace_host_commands.test.mjs` | Execute generated arguments through the installed command; compare question effect with actual confirmed outcome |

Each TypeScript module has a generated `runtime/` counterpart. Existing durable preparation tests now allow additive inspection fields while preserving their task, receipt and canonical-state assertions.

## Code-owned guidance

Context adds a `guidance` projection. Job metadata supports discovery without source inspection. An explicit job ID takes precedence. Otherwise an active preparation task supplies its subject, or exactly one already-Ready job in the current run can supply an implicit read target. This does not select a new job. Multiple Ready jobs require a target; an absent run does not imply a resume choice.

For a missing run, guidance lists active managed resumes, labels, exact decimal resume/fact revisions, fact states and eligibility. It contains no applicant fact values, file paths, digests or claim tokens. Available choices include an argument vector and queue input for the existing public `store application-run-start` command. The descriptor states that explicit input confirmation is required. The model resolves user intent; code does not claim to authenticate it.

Run execution and candidate eligibility share the same guard. The command repeats the guard in its own transaction, so a draft or changed resume after inspection can invalidate advertised arguments without a write. Creating a run and selecting a job remain separate guarded transactions. This slice does not make the two commands atomic or add a run-start replay receipt.

Current preparation preflight supplies blocker codes independently of stored job status. Recognized unreadable-file errors remain file blockers; healthy alternate resumes remain discoverable. Unexpected errors propagate. Existing pending tasks take precedence over a fresh operation; changed pending scope suppresses the confirmation presentation and asks for cancellation/reconciliation. Revoked profile access exposes no run-start descriptor. An active claim suppresses missing-run setup guidance. Underlying mutation guards remain authoritative.

## Confirmation presentation

The code-defined question says that confirmation saves the selection as Ready and does not start filling or submission. Ask responses include its `questionId`, `requestId`, prompt and confirm/decline outcomes. Context repeats the presentation only while its job identity, pending scope and preflight remain current. Inspecting a different job does not expose or invalidate the active task's confirmation. This is an additive response field; it is not persisted in task metadata.

Prompt instructions request the code-defined wording. A model can still paraphrase it incorrectly, and the shell host can still supply its own user-event attestation. Model transcripts must verify wording and reply provenance; a trusted host message/rendering adapter remains future work.

## Verification plan

Focused tests exercise generated descriptors through the installed public command with no source/dependencies in that installation. Existing durable replay, cancellation and revision tests remain required. The skill validator, runtime reproduction, source-size and test-matrix checks apply. The full local gate includes installed Codex/Claude package validation.

Repeat the four paired continuation scenarios with three repetitions per arm using the committed candidate SHA. Record all traces and failed iterations. Compare state outcomes, truthfulness, questions, command effort and latency separately; do not infer an overall UX gain from one successful path. Preserve the prior report as the original evidence.

## Measured comparison

The [48-turn comparison](preparation-guidance-model-eval.md) records all four scenarios at the committed product revision, separate state and explanation scores, descriptive effort/latency, and limitations. Publication receipts remain separate from model outcomes.
