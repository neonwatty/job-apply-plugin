# Python runtime closure

The migration gate distinguishes retained Python runtime assets from Python used
only by repository validation. It scans the installed-artifact contract, the
Companion launcher, and every shipped skill document. A new Python target in
those files fails `check:migration` until it is explicitly classified. Removing
a caller also fails until its now-stale declaration is removed.

The closure inventory retains four classified Python entrypoints:

| State | Entrypoints |
| --- | --- |
| Python rollback/compatibility asset; ordinary skills use the native command first | Store CLI, task CLI, workspace server |
| Python implementation still required | QA replay |

The two Python package trees behind the Store and workspace server also remain
part of the installed artifact for explicit whole-process Python rollback and
compatibility. Their retained inventory does not make Python the ordinary
writer: ordinary Store and task skill flows launch the native CLIs first. The
closure manifest therefore records the package boundary without claiming that
the package is Python-free.

The canonical clone package now gives the existing TypeScript repository a
private, disposable copy of supported Python Store state while leaving the
source untouched. Its ownership and exclusion rules are documented in
[native canonical Store clone](native-canonical-store-clone.md). The Store CLI,
task CLI, and workspace server now have a
[writer-switch rehearsal](native-canonical-writer-rehearsal.md) that compares
their public envelopes and durable restart behavior on independent clones.
Python and TypeScript remain separate writers through an atomic writer handoff:
each ordinary flow selects one complete writer process, and an explicit
whole-process Python rollback does not join or resume a native write. The
Companion provides [controlled writer routing and rollback](controlled-writer-routing.md),
while ordinary skills use the native Store and task CLIs first. The
[installed native Companion candidate](installed-native-companion-candidate.md)
exercises the installed production Next launcher on explicit disposable clones:
HTML/API startup and native writes persist across restart with Python unavailable
on `PATH`. Python initialization and rollback remain separately bounded checks,
and rollback preserves both exact canonical bytes and retained native post-write
state. The installed rehearsal proves quiescence of the complete Python or native
Companion process group before either Store move. Before retiring the rollback
assets, the native Store command surfaces and installed Companion route must
close and pass staging validation. The private attempt broker used by ordinary
application routing is `runtime/cli/native-attempt.js`; its Python predecessor
remains packaged only for explicit rollback, not as an ordinary entry point.

Repository tests, differential Python oracles, source generators, isolated QA
replay, and development checks may continue using Python during this phase. The
Store and workspace Python package trees remain for rollback compatibility;
their later removal is separately scoped work after runtime routing has closed.
