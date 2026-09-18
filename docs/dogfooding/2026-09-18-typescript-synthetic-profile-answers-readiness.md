# TypeScript synthetic profile and answers workflow readiness

Date: 2026-09-18

Branch: `codex/profile-answers-accessible-value-type`

Base: `origin/staging` at `d537abe396e0bcd6a088349b0cd7730efe372a38`

## Scope and safety

This repair owns the candidate workflow, the Answers value-type and revision
rendering seams, their focused browser coverage, and this receipt. It uses
inline fictional data and requires a new isolated Job Apply Store. It does not
read, clone, or mutate the canonical Store, visit an employer site, create an
external account, start a real application, or authorize submission.

No separate fixture file is required. The bounded values are declared directly
in the manifest: fictional first name `Mara`, fictional Arizona locations, and
one non-sensitive hybrid-work answer. A future supervised run must stop if the
fresh Store does not begin with an empty profile and empty answer library.

## Discovery and protocol

The failed training task's fresh catalog listed `job-apply:agent-workflows`.
That task explicitly invoked the skill and read its complete `SKILL.md` and
referenced `protocol.md`. The installed runner was
`@lineagehq/workflows@0.1.0` with protocol `1.0`, resolved from immutable commit
`1e9f91c6f6f0a04bdc8003ef1dbbe68ad3468225`; installed source contained the
observation-only approval fix.

Desktop run `run_41759af63cc4441aa4307887aa1316fd` passed its first five
checkpoints, then failed checkpoint 6 when its worker invoked option selection
on the tab object after entering Question. The control itself was a labeled
native select, but the supported option-selection method belongs to an
accessibility locator. The worker stopped without retrying, committed failure
evidence, and did not start mobile. This repair starts no live runner command
and does not reuse or resume that terminal run.

## Bounded repair

The Answer value type select is now stateful: it reports the retained value's
actual type instead of resetting to a placeholder after each change. A browser
worker can locate it by the exact accessible label `Answer value type` and use
the locator's option-selection operation. Focused production-browser coverage
selects Number, verifies the numeric editor, selects Text, and then completes
answer creation.

The same Answers component now renders the validated integer revision rather
than coercing the rich numeric token object. Browser coverage requires the
selected answer to display `Revision 1`, closing the previously observed
`Revision [object Object]` defect.

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

Candidate revision 2 has eight linear, screenshot-backed checkpoints:

1. verify the empty candidate profile;
2. create exactly two fictional profile fields;
3. update location and prove reload persistence;
4. verify the empty accepted-answer library and confirmation copy;
5. prove a blank required question cannot create a record;
6. select Text through the accessibility-labeled value-type control and create
   one confirmed, non-sensitive reusable answer;
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
| `desktop-web` | `sha256:b90ca911bbb6ab7d702dd03ff7f71da6de9723750f251c2e7f32f49294093666` | `sha256:9233b487813dfb9dbed27c38044531c625581a2fded375936c99ba057271cd76` |
| `mobile-web` | `sha256:b90ca911bbb6ab7d702dd03ff7f71da6de9723750f251c2e7f32f49294093666` | `sha256:079d411366e38a7465e019f964a16930d6641c0b5774e3c2e9675e0c5a8e7757` |

Completed local checks:

- `workflow validate` accepted the project config and repaired candidate;
- `workflow show --json` resolved revision 2 for both platforms with the hashes
  above;
- `npm run companion:typecheck` and `npm run check:size` passed;
- the focused production standalone browser journey passed, including the new
  accessible value-type transition and exact revision badge assertion;
- `npm run companion:build` produced the standalone production Companion;
- `npm run test:release` passed both suites, including the isolated package
  build, packaged browser/CLI walkthroughs, link checks, and isolated Claude
  and Codex installs;
- `npm run test:affected -- --base origin/staging` selected all 25 suites
  because the candidate workflow is conservatively unclassified. Its
  substantive workspace shard passed 1,871 tests with zero failures. The
  aggregate pre-commit invocation remained red only because the historical
  migration audit requires a clean current snapshot and the repair was still
  uncommitted; the clean commit hook and CI are the controlling proof.

## Readiness gaps

- **External orchestration:** Workflows 0.1.0 does not start Companion, bind the
  emitted fragment-token URL, enforce the declared viewport, or stop the
  process. A future operator must perform and verify those steps.
- **Start-state proof:** the runner does not prove an empty Store. The operator
  must verify profile and answer emptiness and stop on any unexpected record.
- **Fresh proof required:** the failed desktop run is terminal and cannot prove
  revision 2. No supervised desktop or mobile replay exists for the repaired
  hashes, so the candidate is not eligible for promotion.

## Handoff gate

After this repair lands, a fresh task must start from its exact merge commit
with a clean worktree; rediscover and invoke `job-apply:agent-workflows`; read
the complete installed contract; install the committed lockfile; verify
runner `0.1.0`, protocol `1.0`, and immutable dependency commit
`1e9f91c6f6f0a04bdc8003ef1dbbe68ad3468225`; and validate the exact revision-2
hashes above. Use a new private Store, fresh run and host IDs, port, fragment
token, authenticated browser tab, and exact manifest viewport. The worker must
locate `Answer value type` through the accessibility surface and operate the
locator-bound select; it must not reuse the failed run, Store, tab, token,
artifacts, or host identity. Desktop must pass cleanly before a separate fresh
mobile run is considered.
