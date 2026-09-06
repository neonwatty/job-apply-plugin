# Data-copy primitive selection evidence

Observed on native macOS arm64 with Node 22.22.3 and Python 3.14.4, after
checkpoint `b1f4bb1`. Two separate owned temporary trees used identical synthetic
setup: source mode 0640, existing target mode 0600, distinct source/target bytes
and conflicting `user.job_apply_probe` attributes. Each tree was removed afterward.

| Data-copy operation | Target mode after data copy | Existing target attribute |
| --- | --- | --- |
| Node `fs.promises.copyFile` | 0640 | retained |
| Python `shutil.copyfile(..., follow_symlinks=False)` | 0600 | retained |

The actual Python data-copy phase leaves existing permissions unchanged; copystat
applies source permissions later, after source stat, timestamps and xattrs.
Node's built-in copyFile changes permissions during the data-copy phase. A
subsequent source-stat or timestamp failure would therefore leave different state
if the TypeScript orchestrator simply substituted copyFile for shutil.copyfile.

Use the frozen partial-copy/metadata-order references to select and verify a
data-only implementation. Changing permissions back afterward is insufficient
without evidence for the intermediate failure and visibility behavior. This
probe does not select that implementation or prove other metadata, new targets,
partial-device-write failures, Linux or Windows behavior. The existing metadata
reference already provides partial-copy mode assertions; the new ordering
reference must bind those effects to the actual source-stat/timestamp boundaries.

Independent source assessment identifies a remaining data-only reference before
choosing an implementation. One owner can capture it in
`tools/contracts/artifact-data-copy/reference.py` and `support.py`, with
`tests_js/artifact_data_copy_reference.test.mjs` and
`docs/migration/artifact-data-copy-reference.md`. The completed metadata-order
reference is unchanged by this proposed package.

Required cases include existing/new targets under explicit umasks; source-open
failure before target truncation; destination-open failure and source cleanup;
same pathname/hard-link rejection; FIFO rejection without blocking; empty and
multi-chunk data; read/write/close failures and their combined exception order;
accelerator fallback and errors after mutation. Distinguish outer critical-path
preflight from direct copyfile behavior. Source opens before target, and target
closes before source in the actual nested Python context managers.

Local Python uses the macOS data-only fcopyfile accelerator and a 262144-byte
fallback copy buffer. Incidental syscall choices need not become universal
requirements, but visible bytes, metadata, error precedence and cleanup at each
failure boundary do. Native success, controlled accelerator/stream failures and
unobserved device faults must remain distinct. Linux and Windows need separate
native evidence. Reusing text-output buffering also requires binary-stream
evidence; it is not established by the prior atomic-JSON tests.
