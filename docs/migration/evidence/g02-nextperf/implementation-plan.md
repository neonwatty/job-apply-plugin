# Reuse immutable migration base facts

Reuse file hashes, physical line counts and source-size ceilings already collected for the same immutable manifest base. Cache absent files using Map.has so null is not confused with empty bytes. Keep caches scoped to one loader invocation and keep each manifest validation independent.

The original fifteen loader cases remain. One test name and its three-blob expected read count are updated explicitly for the aggregate cache capacity change from 8 to 32 MiB; every other original assertion remains. The per-Git-command and repository-file read limits remain 8 MiB, with the same 4096 cached-entry ceiling and copy-on-return behavior. A new capacity regression verifies retention at 30 MiB, eviction beyond 32 MiB, hot entries and caller-copy isolation. An additional controlled actual-loader regression verifies per-base/path reads, absent versus empty values, independent bases, separate manifest validation and fresh reads on a later loader invocation. The original implementation fails the new read-count assertion.

This prerequisite increases only the aggregate retained immutable-byte budget. It changes no task authority, validation decision, timeout, per-read budget, receipt, Store behavior or application route. The existing normal commit and affected checks remain required. The original Next preparation is immutable and unactivated; fresh frontend integration scope must consume this accepted maintenance revision.


The optimization reuses immutable base facts without changing validation decisions. It does not activate application serving or alter Store behavior.
