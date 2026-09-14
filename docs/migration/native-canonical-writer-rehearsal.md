# Native canonical writer rehearsal

The writer rehearsal runs the TypeScript Store CLI, task CLI, and loopback
workspace server against independent clones of one canonical Python Store. A
separate clone remains under Python for each comparison, so the two runtimes
never share a writable directory.

The rehearsal verifies parsed Store CLI job listings, the complete redacted
task snapshot envelope, authenticated HTTP job list and detail reads, an HTTP
job creation, and durable state after both servers stop and restart. Dynamic
timestamps are normalized only after each response has passed its runtime's
ordinary validation. The canonical source tree is snapshotted before cloning
and must remain byte-for-byte unchanged after every mutation and restart.

This closes the disposable-clone assembly proof for those three entry points.
It does not change the default Store path, the shipped skill commands, the
default Companion route, or production activation. The Companion now has
[controlled writer routing and rollback](controlled-writer-routing.md) for a
future staged activation while retaining Python as the default.
