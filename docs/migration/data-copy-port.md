# Explicit-I/O data-copy protocol

Reference checkpoint: `13191ee`. This package implements the data-copy control
flow behind the frozen data-only reference. Every I/O operation is a required
caller-supplied boundary; no native adapter, default filesystem access, launch
integration or live Store activation is included.

## API and ownership

`src/package/data-copy.ts` exports `copyFileData(source, target, options)` and
`copyFileObjects(reader, writer, length)`. Options require an explicit I/O
implementation, Python profile 3.12/3.13/3.14, follow-symlink policy, and platform
`darwin`. Unsupported profiles/platforms reject before I/O. Linux accelerator
chains and Windows semantics are not represented by this API yet.

`src/package/data-copy-io.ts` defines path/metadata checks, stream ownership and
an optional single accelerator. The adapter supplies Python-compatible path
representations and OS-error classification, including `OSError` with no errno.
Directory-error classification includes subclasses while excluding unrelated
OS-error subclasses carrying the same errno. It also owns path encoding, `os.path.islink`/`exists` behavior, native binary
buffering and target opening with truncation plus mode 0666 filtered by umask.
Source and target paths are already represented by the caller's path layer; this
leaf does not normalize or reinterpret them.

The leaf preserves alias checking, FIFO checks, symlink copying, source-before-
target opening, target-before-source closing, fallback chunk lengths and error
precedence. It issues one write per read and ignores the returned write length,
as actual `copyfileobj` does. A propagated accelerator error preserves partial
state; give-up proceeds using the existing streams without reopening them.
Ordinary errors are not rolled back, followed by permission repair, or followed
by an added sync. The adapter must not silently alter those effects.

Errors retain Python implicit context in `pythonContext`. An explicitly translated
missing-destination error also sets JavaScript `cause` and
`pythonSuppressContext=true`, preserving its distinction from implicit exception
context. Caller-facing translation of this metadata remains a later integration
task; no existing global exception representation is changed by this leaf.

## Evidence required for this checkpoint

The independent test model compares all 30 direct-copy cases from the frozen
reference: precise call arguments, error messages/errno/context, returned path,
bytes/digests, modes, complete modeled path sets and descriptor outcomes. The
four whole-package preflight cases remain with the outer package orchestrator.
Model expectations for initial fixtures are constructed independently; test
outcomes are compared to actual Python observations rather than refreshed goldens.

The model has intentional limits: it represents the frozen small pending writes,
full chunks and successful accelerator result, but performs no native file I/O.
Comparing those outcomes proves the protocol's decisions over those supplied
streams; it does not prove Python binary-buffer mechanics, kernel timestamp
behavior or native accelerator equivalence. Native timestamp fields are not
projected into modeled assertions, and no timestamp claim is made for this port.

A separate inline actual-Python witness uses owned temporary files to close the
previously uncovered destination-directory branch. It captures source/target
open, read and close failures, missing versus existing destination, a later
source-close failure, existence-inspection failure, hierarchy-specific directory errors, and a reused
exception instance across read/target-close/source-close. Implicit-context cycles
are broken as Python does while explicit causes remain separate. Tests compare exact call
order, closed descriptors, remaining bytes and separate explicit cause/implicit
context/suppression fields across Python 3.12/3.13/3.14. Four additional actual
stdlib probes establish that same-file and stat checks suppress no-errno
`OSError`, while `ValueError` propagates. Those are controlled boundaries, not
real hardware/device failures.

The worker owns these two sources, `tests_js/data_copy_ts.test.mjs`,
`tests_js/data_copy_support.mjs` and this document. Root owns runtime emission,
registration, combined checks and independent review. Each file remains below
500 physical lines.

## Gates still open

A native binary-stream adapter and its raw read/write/flush/close error evidence
must precede native copy acceptance. Native acceleration, native host coverage,
full critical-destination preflight, metadata composition and exact installed
candidate acceptance remain separate work. This package cannot by itself close
HOST, DIST or a whole migration subset.
