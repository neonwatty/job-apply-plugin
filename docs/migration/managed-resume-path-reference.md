# Managed resume path reference

This bounded package calls the actual `ResumeStorageMixin._managed_resume_path`
with a `SimpleNamespace` containing only `resume_files_path`. No Store is created.
All directories, files and links belong to an automatically removed synthetic
temporary tree. Caller arguments and stdin are rejected before capture.

Run `node --test tests_js/managed_resume_path_reference.test.mjs`. For this run,
PATH included a temporary alias to the already-installed Python 3.12 interpreter;
no installation or default-interpreter change occurred.

Five tests passed, zero skips: 38 cases (36 native, two injected) on each distinct CPython 3.12.13,
3.13.13 and 3.14.4 macOS profile. The default python3 repeats 3.14.4 and adds no
independent profile. Every case compares the complete synthetic tree before and
after: relative paths, kinds, file SHA-256, link targets, modes and nanosecond
mtimes. All trees remained unchanged. Receipts bind the production source hash.

## Observed semantics

- Missing or external storageKind raises the application not-managed error.
  Missing managedFile raises KeyError; null/integer managedFile raises TypeError.
- Normal names, missing final files and an absolute path directly inside the
  managed directory are accepted. The helper does not require the file to exist.
- Dot spelling is collapsed by Path construction. Embedded `nested/../file.bin`
  and even `absent/../file.bin` pass parent-resolution comparison, but the returned
  candidate retains those lexical components.
- Repeated separators and trailing separators collapse during Path construction.
  Multiple missing components followed by dotdot retain their lexical return.
  A regular file as the parent fails identity comparison, while
  `file.bin/../file.bin` passes non-strict resolution on all three observed profiles.
- Empty/dot-only names, parent escape, nested parent and outside absolute paths
  fail the identity check.
- A parent link back into the managed directory passes; a parent link outside
  fails. The accepted return retains the link spelling.
- Link chains inside and outside follow the same comparison. A dangling parent
  link fails, while an absolute link into the managed root and a nested-directory
  link followed by dotdot pass. A managed root that is itself a symlink also
  accepts both its lexical child and an absolute child of its target.
- A final-component link outside the directory or a final-component loop passes
  this helper because it resolves the parent only. Digest/observation policy must
  handle the final component; this helper alone is not containment proof.
- A self-loop or two-link cycle in the parent raises RuntimeError on 3.12.13. On 3.13.13/3.14.4,
  non-strict resolve leaves an unresolved parent whose comparison produces the
  application's invalid-identity StoreError. The difference is preserved exactly
  by exception category; no universal normalization is applied.
- Two scoped fault injections make the first or second `Path.resolve` call raise
  OSError. Both become the exact invalid-identity StoreError. The trace verifies
  the call count and `strict=False`; these cases are marked non-native and do not
  establish native permission-error behavior.

Only the harness-owned temporary prefix is replaced with `<root>` in successful
path outputs and absolute synthetic link targets; candidate dotdot/link components remain intact. Application error
messages are retained verbatim. Interpreter TypeError/KeyError/RuntimeError text
is not frozen because this package compares categories and path semantics.

## Remaining boundaries

This does not cover full managed-resume observation, Store record validation,
file digesting, descriptor opening, deletion, path races or authority checks.
Native Windows/Linux resolution remains unverified. Unsupported symlink creation
is explicitly reported and causes the enclosing profile test to skip rather than
grant complete acceptance. No mocked link outcome substitutes for native evidence.
The reference freezes behavior; an independent review is still required before
acceptance or a compatible TypeScript path implementation.
