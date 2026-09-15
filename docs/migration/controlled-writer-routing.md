# Controlled writer routing and rollback

The Companion launcher now selects one Store writer explicitly. `python` remains
the default. `native-fixture` accepts only an initialized synthetic fixture, and
`native-clone` accepts only a prepared canonical clone. Assembled plugin copies
contain one host-specific Node-API 8 lock provider with a receipt binding its
source and artifact hashes. Native routes verify and select that provider by
default. `--native-lock` remains an explicit development-fixture override. The
legacy `--native-jobs-fixture` option is retained as an exact alias for
`native-fixture`, but it cannot be combined with the new writer or lock options.

Before starting either Store server, the launcher checks the root's ownership
marker. Python is rejected for native fixtures and canonical clones. A native
route is rejected when its expected marker is missing, invalid, or conflicts
with another marker. This prevents a launcher restart from silently assigning
the other runtime to the same writable directory.

The installed-package rehearsal prepares a native candidate, switches the stable
Store path to it, and starts `--writer native-clone` with the packaged provider.
It creates data only in that clone, stops the native server, rolls the stable path
back to the unchanged Python directory, and starts `--writer python`. The native
directory is retained for diagnosis and is never passed to Python. Shipped skills
and the default Companion command continue to select Python until a later
activation change.

The disposable switch rehearsal gives the canonical Store one stable path. With
the owned writer stopped, it verifies that the prepared clone still matches the
Python source digest, retains the Python directory under a deterministic rollback
name, and selects the clone with same-parent renames. Rollback retains the
post-write native directory for diagnosis and restores the exact Python directory
at the stable path. Recovery recognizes each unambiguous interruption state and
fails closed on any extra or conflicting directory. The switch lock serializes
rehearsal controllers; the controller remains responsible for stopping its owned
writer before switching. Installed defaults and live Stores are unchanged.
