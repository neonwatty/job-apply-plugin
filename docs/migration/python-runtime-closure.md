# Python runtime closure

The migration gate distinguishes retained Python compatibility and validation
assets from the ordinary installed runtime. It scans the installed-artifact
contract, Companion launcher, and shipped skill documents. A new Python target
in those surfaces fails `check:migration` until it is explicitly classified.

## Supported installation

Source marketplace packages include reviewed Node-API 8 lock artifacts for
macOS arm64 and Linux x64. Their receipts bind the platform, architecture,
source hash, and artifact hash. Unsupported hosts fail closed; the installed
runtime never compiles or downloads native code.

One installed router owns the ordinary Store, task, attempt, and final-action
policy command surfaces. The Companion launcher owns the workspace surface.
Before a mutating command or workspace launch, the router verifies the packaged
lock, acquires attempt exclusion and Store ownership, prepares a complete clone,
retains the original directory at the deterministic Python rollback path, and
atomically activates the native Store. A fresh Store follows the same path.
Read-only discovery commands that are defined as non-creating remain so.

All shipped skills and README commands use these TypeScript surfaces. No
ordinary command silently falls back to Python, and Python and TypeScript
writers never share the active Store. Existing cached plugin versions must not
be run against a Store after native activation because those older versions do
not participate in native ownership.

## Retained Python assets

Python remains in the repository and installed critical-byte inventory for
rollback compatibility, differential oracles, QA replay, and migration tests.
Those assets do not form an ordinary workflow route. Rollback is an explicit,
whole-process Companion operation after native quiescence; it is not an
automatic per-command fallback.

The [native canonical Store clone](native-canonical-store-clone.md),
[process-owned quiescence controller](process-owned-writer-quiescence.md), and
[controlled routing and rollback](controlled-writer-routing.md) describe the
activation boundary. Installed acceptance covers fresh and existing Stores,
documented profile, task, and resume commands, exact rollback bytes, restart
durability, and execution with an empty `PATH`.
