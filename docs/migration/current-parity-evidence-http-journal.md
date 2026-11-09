# Existing HTTP and journal evidence review

Base: `staging` revision `226281d`. This batch links existing test evidence to
specific planning cells; it does not grant migration acceptance.

## Coordinator recovery

The existing `job CLI read completes a torn-tail coordinator recovery exactly
once like Python` test starts separate Python and native Stores with the same
pending `recover` operation and a torn final `applications.jsonl` line. It
invokes `job-get` through both CLIs, compares their response and the resulting
`jobs.json`, `coordinator.json`, `coordinator-journal.json`, and
`applications.jsonl` contents, verifies that the journal operation is cleared,
then repeats the read and checks that neither Store changes. The fixture covers
one `recover` journal shape and one torn-tail boundary.

Five required planning cells are linked to that exact test identity:

| Surface | Scenario | Observed boundary |
| --- | --- | --- |
| `journal:coordinator-journal.json:operation.kind:recover` | recovery | Pending recover operation is completed. |
| `document:coordinator-journal.json` | recovery | Journal document is cleared to the Python-equivalent state. |
| `journal:coordinator-journal.json:operation:null` | noop | Second read leaves the cleared journal unchanged. |
| `document:coordinator.json` | recovery | Coordinator document matches after recovery. |
| `document:applications.jsonl` | recovery | Torn history tail and replayed event converge to the Python result. |

These are planning bindings, not accepted immutable execution receipts. The
test does not cover other coordinator journal kinds, malformed journals,
different crash points, simultaneous recovery attempts, or a complete document
schema matrix. Those cells remain open.

## Hybrid HTTP assets remain unbound

`hybrid UI serves exact TypeScript helper assets through guarded Python routes`
starts `scripts/job-apply-workspace.py`. It checks seven asset GET/HEAD paths,
bytes, headers, empty HEAD bodies, guarded paths, and one unauthorized API
request. The server under test is the Python reference route; it does not run
the TypeScript HTTP candidate. The candidate catalog paths also differ from
some hybrid runtime paths. Therefore this test cannot yet be linked as
Python/TypeScript parity evidence for the current HTTP surface cells. A future
differential should start both servers on separate disposable Stores and compare
exact responses for each catalog path before those cells are mapped.
