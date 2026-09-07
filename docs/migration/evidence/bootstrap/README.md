# P00/P01 bootstrap audits

These are proposed execution contracts, pending final P01 review. They contain no
results, receipt claims, actors, commit hashes or migration acceptance. The audit
schema deliberately has no product surfaces. A successful later audit can unlock
only its explicit task assignments, never a migration parent or product family.

`p00-audit.json` binds nine inventory-validator tests and four remaining-plan tests.
This is a bounded audit of baseline consistency mechanisms and plan representation;
it is not a claim that every actual source has been behaviorally classified. Its
owned production scope is the inventory checker and remaining-plan checker.

`p01-audit.json` binds seven manifest tests, ten receipt tests, ten loader tests,
one prerequisite-loader test and seven prerequisite-receipt tests. Its owned
production scope is exactly the eight evidence/checker modules. Test support is
owned separately. These numbers describe currently declared literal identities,
not observed execution. The JSON arrays contain the exact names discovered from
current direct `node:test` declarations. If review changes those declarations,
reconcile the audit explicitly before freezing it; do not silently refresh a frozen
contract or weaken the required set to accommodate a failure.

Both audits list their I and V assignment IDs, both future manifest paths, and
no emitted runtime or extra artifacts. Every cell declares its own immutable log
path. The I and V manifests for one package use the same audit cells and may bind
the same captured logs at the same tested subject. V independently reviews that
subject and those logs; it does not claim a second independent test execution.
Distinct reruns would need separately scoped audit contracts with distinct cell
log paths. Across packages, paths are distinct.

## Operational sequence

1. Finish P01 review and commit these exact audit contracts with the approved DAG
   archive. Root is the P00 author; jsonl_review is the P01 author. hooks_audit is
   the independent reviewer for both. These identities belong in the later frozen
   authorizations/manifests and exact-subject reviews, not in this audit schema.
2. Root chooses immutable input bases and binds every existing owned file plus
   relevant imported modules, configuration, test matrix, dependency lockfile and
   oracle inputs. Read-only imported dependencies belong in manifest inputs;
   they do not expand the audit's eight-module production ownership. P00 and P01
   share checker inputs intentionally, so run these bootstrap audits in order.
3. Freeze both I/V manifests for a package together at the declared paths:
   `P00.I.json`, `P00.V.json`, `P01.I.json`, `P01.V.json` in this directory. Bind the
   archived `approved-dag.json`, exact audit hash, structural package hash, actors,
   inputs and captured node-local environment identity. Both manifests precede
   their common tested subject. Do not invent retrospective planning for earlier
   migration commits; rerun the bounded audits after this formal freeze.
4. Activate reviewed catalog entries and reconcile the exact inventory review
   lock. The execution-base boundary follows activation. Validate every planning
   change against exact authorized paths and unchanged input hashes; no source
   edit may be hidden before that boundary. Preserve subject ancestry through
   merges and use isolated branches when actual implementation can overlap.
5. Run each declared command at the immutable subject and capture actual stdout,
   exit code, wall duration, output bytes and supported TAP metrics. The loader
   audit has a 240-second budget; other cells have 60 seconds. All logs have a
   one-MiB bound. These are proposed limits, not claims that any run has passed.
6. Have hooks_audit independently review the exact subject and observed evidence.
   Commit logs after the tested subject, then commit receipts referencing that
   evidence commit. Bind I/V dependency digests to the archived DAG, including
   P00.V before P01.I. The empty structural `dependencies` lists in these audit
   contracts do not waive the assignment DAG prerequisites.
7. Inspect task acceptance from the checker only after all validation succeeds.
   Invalid batches unlock nothing; pending successors hold affected current
   acceptance open until their own valid evidence is available.

## Limits and required checks

No commands run from these contract files during loading. Flat TAP13 is the bounded
reporter; every required literal identity must exist at the accepted subject and
be observed without failure, skip, cancellation, todo or timeout. Observed terminal
TAP duration must fit its budget and agree with measured runner time under the
protocol's one-millisecond tolerance. No timing/result placeholders are permitted.

The longer actual-Git lifecycle suite belongs in the full integration tier and the
focused bootstrap audit; ordinary commits retain fast pure-validator checks. The
snapshot tests exercise the evidence loader's staged-tree lifecycle, not all hooks
or native adapters. Production ownership handoff and evolving DAG lineage remain
separate follow-on work. Frozen DAG/manifests/logs must never be rehashed in place to
manufacture historical acceptance. No live Store or production runtime is activated.
