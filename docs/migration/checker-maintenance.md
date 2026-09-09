# Checker maintenance snapshots

Checker-only changes after the reviewed migration boundary
`6de52b694b1247661fba302bf504eeb4a2a5c688` may use ordinary reviewed Git
snapshots instead of first creating a migration assignment and activation.
The exact file allowlist is `MAINTENANCE_FILES` in
`tools/migration/snapshot-maintenance.mjs`. It excludes product source,
package/configuration files, historical manifests and evidence receipts.

Every post-boundary commit modifying an exempted file must be single-parent,
contain only additions/modifications from that allowlist, and contain regular
tracked files. Mixed product commits, renames, deletions and merges cannot claim
this exception. A later restoration does not hide a disallowed modification.
Unrelated repository histories receive no exception.

This changes pending-task drift and current checker-file freshness classification. Historical lineage,
activation, immutable inputs, manifests and receipts are still fully validated.
An old valid receipt for a changed checker file remains historical evidence;
current acceptance stays open. Missing or invalid original evidence still fails.
It grants no accepted task/package or workflow status. Normal hooks validate
the staged immutable snapshot and bind their actual results as before; none of
their suites or timeouts are skipped or relaxed. If the historical audit fails
or times out, maintenance validation has not passed.

The initial optimization indexes canonical record sets and avoids ancestry
queries for already-preserved sets. Git reverse-topological history can omit
impossible descendant-to-ancestor comparisons. Activation discovery tracks
the minimal frontier while retaining incomparable first activations. Small
exhaustive DAG tests compare these operations to the original full comparison.

For exact commit IDs, reachability uses the already-read Git history for both
positive and negative answers. Tags, unknown IDs and failed bounded reads retain
the original merge-base fallback. Shallow/graft changes invalidate cached
history before reuse. Tests cover more than 4096 distinct negative queries and
changing a shallow boundary during one reader's lifetime.

No historical checkpoint or cache-based acceptance is introduced. A later
checkpoint policy requires independently successful audit evidence and explicit
invalidation rules. This maintenance policy is not a general product workflow
exception; candidate integration must reconcile its own source boundaries.
