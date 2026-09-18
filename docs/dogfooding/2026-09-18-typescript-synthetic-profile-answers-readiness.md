# TypeScript synthetic profile and answers workflow readiness

Date: 2026-09-18

Branch: `codex/synthetic-profile-answers-workflow`

Base: `origin/staging` at `9a7e56ee5426e3334918bd0017f959a78a530144`

## Scope and safety

This preparation slice owns only the candidate workflow and this receipt. It
uses inline fictional data and requires a new isolated Job Apply Store. It does
not read, clone, or mutate the canonical Store, visit an employer site, create
an external account, start a real application, or authorize submission.

No separate fixture file is required. The bounded values are declared directly
in the manifest: fictional first name `Mara`, fictional Arizona locations, and
one non-sensitive hybrid-work answer. A future supervised run must stop if the
fresh Store does not begin with an empty profile and empty answer library.

## Discovery and protocol

The fresh task catalog listed `job-apply:agent-workflows`. The skill was
explicitly invoked, and its complete `SKILL.md` and referenced `protocol.md`
were read before preparation. The installed runner is
`@lineagehq/workflows@0.1.0` with protocol `1.0`.

No live runner command was issued. In particular, this task did not invoke
`workflow train`, create or claim a run, request a lease, register evidence, or
commit an assessment. Live training remains prohibited until the shared
observation-only approval defect is fixed and that fix is available in the
training environment.

## UI and prior-evidence inspection

The journey was derived from the production Companion components and browser
support suites for Facts and Answers, plus the 2026-09-17 TypeScript application
and owner-control dogfooding tranches. Those sources establish revision-bound
profile writes, accepted-answer creation, draft preservation, explicit
sensitive-value consent, pending review, reload durability, and the 390-pixel
layout boundary.

A local production Companion build was opened against a disposable private
Store under `/private/tmp`; the absent legacy-profile path prevented owner-data
import. Browser inspection confirmed:

- revision-1 Facts showed `No profile facts yet`;
- fictional `firstName` and `location` fields saved and survived reload;
- Accepted Answers initially showed zero records;
- one confirmed non-sensitive answer was created, edited, and survived reload;
- Pending questions displayed the per-resolution owner-confirmation boundary;
- at `390x844`, the Answers workspace and confirmation copy remained visible
  and the document had no page-level horizontal overflow.

The disposable UI inspection was not an Agent Workflows run and produced no
runner evidence. Its Store is not a permissible input to future training.

## Candidate journey

The candidate has eight linear, screenshot-backed checkpoints:

1. verify the empty candidate profile;
2. create exactly two fictional profile fields;
3. update location and prove reload persistence;
4. verify the empty accepted-answer library and confirmation copy;
5. prove a blank required question cannot create a record;
6. create one confirmed, non-sensitive reusable answer;
7. edit that answer and prove reload persistence;
8. verify Pending remains empty and manual resolution stays owner-confirmed.

Desktop uses `1440x900`; mobile uses `390x844`. The mobile start override repeats
all safety constraints because Workflows 0.1.0 replaces rather than merges the
constraints array. Mobile guidance distinguishes horizontally scrollable
workspace navigation from prohibited page-level overflow.

## Validation and hashes

The candidate and project config validate with the pinned runner. `workflow
show --json` resolves all eight steps on both platforms. Reproducible hashes:

| Platform | Source hash | Effective hash |
| --- | --- | --- |
| `desktop-web` | `sha256:11f1177d7703f8e8c38614db72ca97896aa3e48879ee660d31602c6ef096894d` | `sha256:9ffe81d52e0a842d5497ec60db703be859d634d3817fd9b1744d4b8ef1527c49` |
| `mobile-web` | `sha256:11f1177d7703f8e8c38614db72ca97896aa3e48879ee660d31602c6ef096894d` | `sha256:ef71f299ca231fda1e5fb1a8b33070d6e902347cc8d32699121a2aba7473ef1f` |

Completed local checks:

- `workflow doctor --json` passed with package `0.1.0`, Node `v22.22.3`,
  and all six expected schemas;
- `workflow validate` accepted the project config and both candidate manifests;
- two independent `workflow show --json` invocations per platform produced
  byte-identical output and the hashes above;
- YAML parsing accepted the config and both candidate manifests.

- `git diff --check` and `npm run check:size` passed; the manifest is 301
  physical lines and this receipt is below the 500-line policy limit;
- `npm run test:affected -- --base origin/staging` selected 25 suites because
  the new workflow path is not yet classified. Twenty-four suites passed,
  including the Companion production standalone browser journey and its Facts,
  Answers, persistence, sensitive-consent, pending-review, and 390-pixel
  coverage. The aggregate gate remained red only because `migration-inventory`
  intentionally refuses a dirty pre-commit snapshot (`Historical audit requires
  a clean current snapshot`). No product or workflow assertion failed.

## Readiness gaps

- **Hard block:** the shared observation-only approval defect is not yet fixed
  and available. Do not begin live runner training.
- **External orchestration:** Workflows 0.1.0 does not start Companion, bind the
  emitted fragment-token URL, enforce the declared viewport, or stop the
  process. A future operator must perform and verify those steps.
- **Start-state proof:** the runner does not prove an empty Store. The operator
  must verify profile and answer emptiness and stop on any unexpected record.
- **Observed product display defect:** after answer creation, the production
  Companion rendered the selected-answer revision badge as `Revision [object
  Object]`. Creation, editing, disk persistence, and reload readback still
  worked. The workflow therefore does not use that badge as persistence proof;
  a product fix is outside this isolated journey's ownership.
- **Replay evidence:** no supervised desktop or mobile replay exists yet, so
  the candidate is not eligible for promotion.

## Handoff gate

After the shared approval defect is fixed and available, use a new ignored
Store and a fresh authenticated Companion URL. Reconfirm skill discovery and
the installed `0.1.0`/protocol `1.0` contract, validate the exact committed
manifest hashes, and only then begin an owner-approved supervised desktop run.
Mobile must use another fresh Store; no prior Store or evidence may be reused.
