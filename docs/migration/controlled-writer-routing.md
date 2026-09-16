# Controlled native writer routing

The ordinary Companion and command router select the native canonical Store.
Each supported package carries a host-specific Node-API 8 lock provider with a
receipt binding its source and artifact hashes. Native routes verify that
provider before touching the Store. `--native-lock` remains a development
fixture override on the lower-level CLIs.

Before activation, the process-owned writer controller holds a Store-lifetime
ownership lease and the router holds attempt exclusion. It prepares a complete
clone under Store locks, verifies source and candidate digests, retains the
original directory under the deterministic migration-backup name, and selects the clone
with same-parent renames. Fresh Stores use the same preparation and activation
machinery. Recovery accepts only unambiguous interruption states and fails
closed on extra or conflicting directories.

The Store, task, attempt, and final-action policy surfaces all pass through the
same installed router. The workspace launcher uses the same native activation
path. A command cannot fall back to another runtime after activation, and ownership
markers prevent the launcher from assigning an incompatible writer to a native clone.

The installed launcher no longer exposes the transitional Python rollback command.
The pre-activation directory remains a byte-exact migration backup so an owner can
recover it with the previous stable package if migration support is required. The
current package never starts that package or a Python process.

Installed tests run the production launcher and documented command surfaces
with an empty `PATH`, cover fresh and legacy Stores, verify restart durability,
and scan the installed tree for Python files. Unsupported platforms and invalid or
missing packaged artifacts fail before activation.
