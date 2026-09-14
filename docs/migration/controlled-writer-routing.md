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

The installed-package rehearsal starts native operation with `--writer
native-clone` and the clone root, allowing the launcher to select the packaged
provider. It creates data only in that clone, stops the native server, and then
starts `--writer python` against the unchanged canonical source root. The clone
is retained for diagnosis and is never passed to Python; the canonical source
is never passed to the native writer. Shipped skills and the default Companion
command continue to select Python until a later activation change.
