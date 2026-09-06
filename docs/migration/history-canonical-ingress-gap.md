# Canonical string caller evidence

Read-only assessment after reference checkpoint `6c2a448` found that literal
Python surrogate pairs cannot be dismissed as universally unreachable through
product input. Canonical comparison remains an open SEM/caller dependency.

The assessor invoked the actual `_read_json` method from
`scripts/job_apply_workspace/http.py` on a synthetic request, using its extracted
AST and ordinary JSON decoding. A JSON string containing raw bytes
`ED A0 80 ED B0 80` yielded Python code points `[D800, DC00]`. An ASCII JSON
escaped pair and a correctly encoded UTF-8 scalar both yielded `[10000]`.
The production method passes request bytes directly to `json.loads`, whose
byte-input decoding permits this distinction. This is a method-level witness,
not an end-to-end HTTP route or write acceptance test.

The current TypeScript PythonJson string representation collapses those two
Python values into the same JavaScript string. The new history reference keeps
explicit code points precisely so a test adapter cannot hide that distinction.

## Traced callers and limits

CLI history append goes through `cli_dispatch.py`, `_read_input` in
`scripts/job-apply-store.py`, and `SessionHistoryMixin.append_history`. Optional
role/company strings survive validation. File input uses strict UTF-8; all
supported stdin decoder configurations have not been established.

Coordinator history copies company/role/ats from a job. The inspected HTTP job
creation path retains incoming strings but persists through `atomic_write_json`
and strict UTF-8 before later history reload. Literal surrogate code points fail
that encoding, so this trace does not prove a complete HTTP-to-history collision.

History reading uses strict UTF-8 text and JSON parsing. Literal surrogate bytes
fail decoding and escaped adjacent pairs combine. However, the idempotency
helper compares canonical strings before append encoding, so its distinction
is real even when a later persistence attempt would fail.

No exhaustive claim is made about string construction, configured stdin or
other routes. A restricted canonical implementation needs an explicit and
enforced input scope; the current HTTP parser does not prove a universal scalar
restriction. Next work must freeze the actual raw-body decoding and downstream
failure behavior, then resolve the representation or scope with caller evidence.
Do not collapse inputs in a test-only adapter or change HTTP decoding silently.
