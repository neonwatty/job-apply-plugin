# Native canonical Store clone

The TypeScript Store can now prepare and open a migration clone of a canonical
Python Store. Preparation takes the Python-compatible exclusive Store lock,
copies the supported private files into a newly created private directory, and
writes the native ownership marker only after every required document is
durable. The source Store is never modified.

This boundary is deliberately narrower than a writer switch. The target must
not exist, both Store paths must be real absolute private paths; their parents must be
owned canonical directories without group/other write permission, and
every copied file must be private, owned, singly linked, and within the bounded
size profile. Unknown root entries, policy state such as `auto-submit`, linked
directory entries, incomplete core state, or a source change during a read
abort preparation and remove only the newly created target.

Missing TypeScript journals are initialized in the clone. Existing supported
documents retain their exact bytes. The clone marker records a digest of the
copied source tree, and the native repository accepts it only when it is the
sole recognized ownership marker. Synthetic fixtures keep their existing
marker and behavior.

Clone preparation alone does not switch a writer. Current shipped skills and
Companion use [controlled native routing](controlled-writer-routing.md), which
prepares and activates the clone before serving native data operations. The
installed package does not run Python. Historical writer-switch rehearsals are
development evidence; they are not instructions to enable concurrent writers
or to point an older package at an activated native Store.
