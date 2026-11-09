# Python runtime closure

The migration gate proves that the installed-artifact contract, Companion
launcher, and shipped skill documents contain no Python runtime target. The
manifest is closed: a new Python runtime target or undeclared entrypoint fails
`check:migration`. This checks routing, not file filtering by a marketplace host.

## Supported installation

Source marketplace packages include reviewed Node-API 8 lock artifacts for
macOS arm64 and Linux x64. Their receipts bind the platform, architecture,
source hash, and artifact hash. Unsupported hosts fail closed; the installed
runtime never compiles the lock addon or downloads a Node interpreter. A
source-only Companion first launch installs pinned npm dependencies and builds
its server; those dependencies may include their own prebuilt native binaries.

One installed router owns the ordinary Store, task, attempt, and final-action
policy command surfaces. The Companion launcher owns the workspace surface.
Before a data command or workspace launch, the router verifies the packaged
lock, acquires attempt exclusion and Store ownership, prepares a complete clone,
retains the original directory as a deterministic migration backup, and
atomically activates the native Store. A fresh Store follows the same path.
Help does not activate a Store. `store paths` and `policy status` do not create
an absent Store; an existing unactivated Store can still be activated by those
commands. A read request is not generally an activation-free probe.

All shipped skills and ordinary README commands use these TypeScript surfaces.
No installed command starts or falls back to Python. Existing cached plugin
versions must not be run against a Store after native activation because those
older versions do not participate in native ownership.

## Repository reference assets

Python reference assets remain in the repository for differential oracles and
historical regression evidence. Raw source-checkout installations can retain
those files. The release harness tests real source installations separately from
its reduced assembled fixture, which excludes reference trees. Neither form
uses those references as production workflow routes. Required runners reject
Python execution; source-install acceptance exercises the public native paths. Native QA replay is
part of the installed TypeScript runtime.

The [native canonical Store clone](native-canonical-store-clone.md),
[process-owned quiescence controller](process-owned-writer-quiescence.md), and
[controlled native routing](controlled-writer-routing.md) describe the
activation boundary. Installed acceptance covers fresh and existing Stores,
documented profile, task, resume, and replay commands, restart durability,
artifact scanning, and execution with an empty `PATH`.
