# Python runtime closure

The migration gate distinguishes retained Python runtime assets from Python used
only by repository validation. It scans the installed-artifact contract, the
Companion launcher, and every shipped skill document. A new Python target in
those files fails `check:migration` until explicitly classified. Removing a
caller also fails until its now-stale declaration is removed.

## Current supported installation

Ordinary GitHub/source marketplace installs use the complete Python writer
route: Store, task, attempt broker, final-action policy, and workspace commands.
The shipped skills and README consistently describe that route. Python remains
required; the package is not Python-free. No ordinary command switches to a
native writer after a Python task or silently falls back after a native error.
The explicit whole-process Python rollback remains available for controlled
native rehearsals. Python and TypeScript writers must never share one live Store.

The inventory retains eight classified Python entrypoints:

| State | Entrypoints |
| --- | --- |
| Ordinary Python runtime with TypeScript prepared-Store or fixture implementations | Store CLI, task CLI, workspace server |
| Python runtime still required by shipped routing | attempt broker, final-action policy, QA replay |
| Python helpers still referenced by shipped workflows with TypeScript implementations | trusted fill, form readiness |

The Store and workspace Python package trees remain critical installed assets.
The Python attempt broker remains a fixed critical file. Native runtime assets
remain packaged for prepared-Store rehearsals and differential validation.

## Deferred native cutover

Final review found that source marketplace packages contain only the packaged
lock README, not a verified flock addon. The native `init` command does not
prepare a complete native Store or activate an existing Python Store. Selecting
native executables in skill instructions cannot close either boundary. Ordinary
native routing is therefore deferred. Runtime addon compilation/download and
in-place marking of an existing Python Store are prohibited.

A future cutover must provide a tested assembled installation containing the
verified addon for each supported target, complete fresh-Store initialization,
and an exclusive activation/rollback path for an independently prepared copy of
existing canonical state. It must quiesce the entire previous writer process
group before any Store move and verify every documented CLI contract, including
resume import. Changing the default writer requires all ordinary workflows to
switch together, with no Python/TypeScript mixed mutation path.

## Retained preparation and evidence

The [native canonical Store clone](native-canonical-store-clone.md) gives
TypeScript a private disposable copy of supported Python state, leaving the
source untouched. The [writer-switch rehearsal](native-canonical-writer-rehearsal.md)
compares public envelopes and durable restart behavior on independent clones.
The Companion retains [controlled routing and rollback](controlled-writer-routing.md).
The [installed native Companion candidate](installed-native-companion-candidate.md)
exercises an assembled production launcher on explicit disposable clones; it is
not evidence that source marketplace installation can activate a live Store.

This tranche retains the native attempt broker hard-link ownership guard and
prepared native Jobs/task packaged-addon resolution. Both prepared CLIs expand a
home-relative `JOB_APPLY_STORE_DIR`. Tests distinguish assembled prepared-native
fixtures from source-only installs and run documented Python initialization,
profile, task, and resume commands against fresh and existing disposable Stores.
Repository tests, Python differential oracles, generators, and isolated QA replay
remain available. Migration acceptance remains open.
