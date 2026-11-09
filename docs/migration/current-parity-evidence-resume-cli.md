# Resume CLI Python/native comparison

This batch starts with separate disposable Python and native Stores. The test
aligns their initial `resumes.json`, then runs the same commands against each.
It compares exit status, JSON response, diagnostic, the durable resume document,
managed file bytes and private file modes. Random content revision tokens and
independently sampled timestamps are checked for shape and normalized for
cross-process comparison. It also checks that reads, rejected actions, and
no-op actions leave JSON/JSONL state and managed files unchanged.

The passing lifecycle covers create, get, list, check, resolve, metadata update,
set default, trash, restore, and permanent delete. The failure path covers
duplicate creation, unsupported fields with a valid source path, stale
revisions, and invalid lifecycle actions. The create response is checked for
absence of the original source path; imported bytes must appear in private
managed storage with the same digest and mode in each Store.

One **confirmed diagnostic difference** was fixed. With an initialized Store and
input `{"unexpected":true}`, Python `resume-create --input` exits 2 with
`resume input contains unsupported fields`. Native previously returned
`resume path must be a string` because it checked the source path first. The
native CLI now checks unsupported fields first, matching Python's diagnostic.
The exact case remains as a passing equality regression. Neither
implementation writes Store state for this rejected input.

This requirement shard maps only the 22 resume CLI scenario cells exercised by
passing comparisons. Mapped requirements remain planned evidence and do not themselves
close migration acceptance.
