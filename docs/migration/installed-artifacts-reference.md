# Installed artifact reference

Bounded reference package prepared against base `1da7f3f`. The driver calls the
actual `critical_paths`, `assert_critical_bytes` and `copy_critical` functions in
`scripts/smoke/artifacts.py`. No TS implementation, runtime distribution choice,
host installation or delivery acceptance is granted here.

Allowed files are the two Python files under
`tools/contracts/installed-artifacts`, the corresponding
`tests_js/installed_artifacts_reference.test.mjs`, and this document.
All source/target trees, symlinks and FIFO belong to automatically removed
temporary directories. Caller arguments and stdin are rejected; no Store is
initialized or accessed. Imported fixture modules do not write bytecode caches.

## Frozen observations

Thirty-three fixed cases cover eleven synthetic critical files, including a
nested runtime module and binary NUL/FF/newline payload bytes. Each receipt binds
the actual production source hash, exact fixed-file/tree declarations and Python
profile. Tests independently bind case IDs, operations, mutations, sorted
inventories, exact SystemExit messages, and outcomes.

- Inventory includes the fixed files and regular files recursively under each
  critical tree. Extra files within those trees enter the inventory; files
  outside those trees are ignored. Empty critical trees are valid and add no
  file entries. Empty subdirectories do not alter verification.
- Missing fixed files and missing critical trees have the actual distinct
  traversal errors frozen. A directory replacing a fixed file, a file replacing
  a tree, a file replacing an ancestor, and a nested FIFO are rejected.
- Fixed, ancestor, dangling, nested file and nested directory symlinks are
  rejected. A symlink supplied as the declared root is resolved and accepted:
  the current helper does not reject that root alias. These are observed
  semantics, not a new universal containment policy.
- Verification compares complete critical inventories and exact bytes. A
  missing nested file or extra critical file rejects on inventory mismatch;
  a missing fixed file rejects earlier. Changed content rejects with its exact
  relative path. Mode changes and unrelated files do not make verification fail.
- Copying into an empty or populated target preserves critical source bytes,
  file modes and mtimes. Extra target critical files remain; copy is not pruning
  or synchronization and does not automatically perform a verification pass.
- Empty source trees are not copied as directories. Copy can succeed while a
  later inventory of the target would reject those absent critical trees.
- Source validation and destination preflight failures leave the owned trees
  unchanged. Rejected copies start with distinct target manifest sentinel bytes
  so copying an earlier file cannot hide behind already-identical contents.

Before/after snapshots record relative paths, entry kinds, permissions, mtimes,
regular-file SHA-256 and lexical link targets, without following links or opening
the FIFO. Read-only/rejected operations preserve the complete snapshot. Copies
preserve the source snapshot and independently match target critical file bytes,
modes and mtimes against the synthetic source. Access times are excluded because
reading may update them. This does not establish interrupted-copy rollback.

## Verification and remaining gates

Command: `node --test tests_js/installed_artifacts_reference.test.mjs` with the
existing Python 3.12 executable alias temporarily on PATH. No installation or
default-interpreter change occurred.

Local result: five tests passed, zero failures or skips. All 33 cases were
observed on CPython 3.12.13, 3.13.13 and 3.14.4 on the current macOS host. Default
python3 repeats 3.14.4 and is not a fourth independent profile. Child capture is
bounded to 15 seconds and 2 MiB; no full/browser/package suite is invoked.

Native Windows remains unverified and its profile tests explicitly skip. Linux
has not been run by this package. Symlink/FIFO setup failures on a POSIX host
fail capture rather than silently converting that host into a passing cell.
Permission-denied traversal, os.walk error suppression, multiple simultaneous
defects/traversal ordering, path-byte names, file replacement races, copy failures
after preflight, ACLs/xattrs and missing-root exception details remain separate
reference work. No transactional or crash-safe copy guarantee is inferred.

Root independently reviewed the driver, fixtures and tests. Review required
closed post-copy path sets and preservation of all non-copied file/link entries;
both checks and an explicit root-alias witness are now included. An immutable
capture precedes the TS port. Python-free
installed-package execution, actual Codex/Claude host launch, signatures,
offline use, upgrade and rollback remain HOST/DIST acceptance gates.
