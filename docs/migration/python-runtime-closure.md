# Python runtime closure

The migration gate now distinguishes Python reached by shipped product routing
from Python used only by repository validation. It scans the installed artifact
contract, the Companion launcher, and every shipped skill document. A new Python
target in those files fails `check:migration` until it is explicitly classified.
Removing a caller also fails until its now-stale declaration is removed.

The current shipped routing reaches eight Python entrypoints:

| State | Entrypoints |
| --- | --- |
| TypeScript implementation exists for synthetic fixtures only | Store CLI, task CLI, workspace server, Trusted Fill authority, form-readiness contract |
| Python implementation still required | attempt broker, campaign/final-action policy, QA replay |

The two Python package trees behind the Store and workspace server also remain
part of the installed critical artifact. A TypeScript implementation is not a
runtime replacement while it requires `.native-jobs-fixture`, an explicit native
lock addon, or a disposable Store clone. The closure manifest therefore cannot
claim an entrypoint removed or replaced.

The canonical clone package now gives the existing TypeScript repository a
private, disposable copy of supported Python Store state while leaving the
source untouched. Its ownership and exclusion rules are documented in
[native canonical Store clone](native-canonical-store-clone.md). The Store CLI,
task CLI, and workspace server now have a
[writer-switch rehearsal](native-canonical-writer-rehearsal.md) that compares
their public envelopes and durable restart behavior on independent clones.
Python and TypeScript still remain separate writers. The Companion now provides
[controlled writer routing and rollback](controlled-writer-routing.md): Python
remains the default, native operation requires an explicitly owned fixture or
clone, and rollback returns to the untouched canonical source rather than
reassigning the clone to Python. Only after staging validation should shipped
skills or the default Companion route be changed to Node.

Repository tests, reference oracles, source generators, and development checks
may continue using Python during this phase. Their later removal belongs to the
final Python-free artifact gate, after runtime routing has closed.
