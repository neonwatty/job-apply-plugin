# Current parity evidence batch 03: job CLI contention and recovery

Base: merged `staging` revision `3d188bfaf4c4d9213cd5f974f6c179990ebbc05f`.
This batch extends the Python/native CLI differential on disposable Stores. It
declares test bindings and does not grant migration acceptance.

## Exercised boundaries

- Four independent processes contend to create the same job. Python and native
  each produce one success and three duplicate-ID rejections, with the same
  resulting jobs document and no writes to other state files.
- Four processes contend on the same update revision, then the same trash
  revision. Each CLI produces one winner and three revision rejections. A new
  process reads the settled revision and trashed state from disk.
- A `job-get` read starts with a pending coordinator recovery journal and a
  torn final history line. Both CLIs repair and complete the same coordinator,
  journal and history state. A second read leaves those bytes unchanged.
- The installed native `store` router activates a disposable copy of a Python
  Store, then runs create/get/list/update/transition/trash/restore/delete with
  Python absent from its `PATH`. It matches the Python CLI responses and jobs
  document while preserving the original Python rollback `jobs.json` bytes.

Responses are compared as parsed JSON. Independently sampled ISO timestamps
are normalized, and the Python diagnostic prefix is removed. Concurrent
requests use identical payloads so winner scheduling cannot hide a response or
durable-state difference. The installed router test compares the original
rollback bytes without normalization.

## Requirement mapping and limits

`requirements-current-job-cli-02.json` maps five cells: concurrency for
`job-create`, `job-update`, and `job-trash`, plus interruption and recovery for
the specific `job-get` torn-tail/journal case. The installed router test is
added to the existing valid-job requirement binding. The unmapped count falls
from 7,671 to 7,666.

The interrupted-read fixture is one coordinator recovery state, not all crash
boundaries. Contention is four CLI processes for these three commands, not a
full cross-command or eight-writer transaction matrix. Other job commands,
native host cells, and full accepted execution receipts remain open.
