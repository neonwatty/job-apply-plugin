# Managed observation and cache reference

This reference calls the actual `_managed_resume_observation` method without
creating a Store. A synthetic instance supplies a fixed clock, an owned path
boundary and the real private digest helper. Actual file metadata and cache
identity come from the production helpers. All files live in disposable trees.

Coordinator-owned `allowed_files` are this document,
`tools/contracts/managed-observation/reference.py` and
`tests_js/managed_observation_reference.test.mjs`. Independent review precedes
freezing and any dependent implementation.

Eighteen cases retain successful observations, initial cache population, fresh
and zero-age reuse, expiry at 30 seconds, future timestamps, identity mismatch,
disabled cache policy, missing/directory/symlink/oversized files, null digest, changed
post-read identity, both stat failure boundaries and malformed cache records.
Fresh cache reuse returns the cached digest without reading file content. Expired,
future or identity-mismatched entries are replaced after a successful stable read.
Missing cached timestamp or digest raises KeyError rather than silently repairing
the entry. The disabled-cache case invokes the real identity helper's Windows
policy branch, but does not claim a native Windows filesystem observation.

Fixed expected results include digest, byte size, UTC timestamp, exact call counts
and cache effects. Before/after snapshots bind names, kinds, bytes, modes and
nanosecond mtimes. Only the deliberate after-read mutation changes the tree;
observation then returns the missing shape. Stat errors, null digest and file
mutation are explicitly injected around real operations. They do not substitute
for native permission or scheduling evidence.

Run `node --test tests_js/managed_observation_reference.test.mjs` with the installed
Python 3.12, 3.13 and 3.14 aliases available. Input and argument rejection is also
tested; missing profiles never count as a passing compatibility cell. Exact
production source hashes and interpreter profiles accompany every capture.

Scope remains observation/cache control flow. Managed-path resolution is a
separate reference; it is deliberately replaced here with the owned path. Symlink replacement races, reparse points, permission denial, simultaneous writers, interruption,
platform metadata precision and full Store call-site behavior remain required
separate evidence. This document grants no parent FS or runtime activation gate.
