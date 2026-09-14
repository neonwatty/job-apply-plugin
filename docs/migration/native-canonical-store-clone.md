# Native canonical Store clone

The TypeScript Store can now prepare and open a migration clone of a canonical
Python Store. Preparation takes the Python-compatible exclusive Store lock,
copies the supported private files into a newly created private directory, and
writes the native ownership marker only after every required document is
durable. The source Store is never modified.

This boundary is deliberately narrower than a writer switch. The target must
not exist, both paths and their parents must be real absolute private paths, and
every copied file must be private, owned, singly linked, and within the bounded
size profile. Unknown root entries, policy state such as `auto-submit`, linked
directory entries, incomplete core state, or a source change during a read
abort preparation and remove only the newly created target.

Missing TypeScript journals are initialized in the clone. Existing supported
documents retain their exact bytes. The clone marker records a digest of the
copied source tree, and the native repository accepts it only when it is the
sole recognized ownership marker. Synthetic fixtures keep their existing
marker and behavior.

Shipped skills and the Companion still route to Python. This package creates a
safe rehearsal target for the Store, task CLI, and workspace server; it does
not adopt the live Store, enable concurrent Python and TypeScript writers, or
activate native product routing. A later writer-switch rehearsal must validate
the public CLI and HTTP envelopes against a disposable clone before routing can
change.
