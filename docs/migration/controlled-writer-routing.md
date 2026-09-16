# Controlled writer routing and rollback

The ordinary Companion and command router select the native canonical Store.
Each supported package carries a host-specific Node-API 8 lock provider with a
receipt binding its source and artifact hashes. Native routes verify that
provider before touching the Store. `--native-lock` remains a development
fixture override on the lower-level CLIs.

Before activation, the process-owned writer controller holds a Store-lifetime
ownership lease and the router holds attempt exclusion. It prepares a complete
clone under Store locks, verifies source and candidate digests, retains the
original directory under the deterministic rollback name, and selects the clone
with same-parent renames. Fresh Stores use the same preparation and activation
machinery. Recovery accepts only unambiguous interruption states and fails
closed on extra or conflicting directories.

The Store, task, attempt, and final-action policy surfaces all pass through the
same installed router. The workspace launcher uses the same native activation
path. A command cannot fall back to Python after activation, and ownership
markers prevent the current launcher from assigning Python to a native clone.

Explicit rollback stops the complete owned native process group before the
first rename, preserves the post-write native directory for diagnosis, and
restores the exact retained Python directory at the stable path. Python remains
available for that bounded compatibility operation and repository validation;
it is no longer the ordinary writer.

Installed tests run the production launcher and documented command surfaces
with an empty `PATH`, cover fresh and Python-created Stores, verify restart
durability, and compare rollback bytes. Unsupported platforms and invalid or
missing packaged artifacts fail before activation.
