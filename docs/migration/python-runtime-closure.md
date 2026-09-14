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

The next assembly package should make the existing TypeScript Store, task CLI,
and workspace server open an exact canonical Store clone without the synthetic
fixture marker. It must preserve the native lock owner, schema/version checks,
startup recovery, durable bytes, and public CLI/HTTP envelopes. Python and
TypeScript must remain separate writers until the writer-switch rehearsal passes.
Only after that package is accepted should shipped skills or the Companion
launcher be changed to Node.

Repository tests, reference oracles, source generators, and development checks
may continue using Python during this phase. Their later removal belongs to the
final Python-free artifact gate, after runtime routing has closed.
