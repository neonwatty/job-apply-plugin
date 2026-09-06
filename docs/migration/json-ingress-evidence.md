# Synthetic JSON ingress evidence

Date: 2026-09-06. SEM evidence only; no production decoder or routing changed.
Owned files are this document, `tools/contracts/json-ingress/reference.py`, and
`tests_js/python_json_ingress.test.mjs`. Integration owns test registration.

## Scope and provenance

The fixed reference has 25 input cases: 13 byte bodies, six CLI scope strings,
and six JSONL lines. It emits 77 outcomes: 45 actual production wrapper calls,
26 direct decoder calls, and six JSONL branch reproductions. Every byte body is
tested through five ingress operations. These counts are not 77 distinct inputs.

Actual functions invoked:

- `scripts/job-apply-store.py` `_read_input("-")`: in-memory stdin explicitly
  configured as UTF-8/strict; original stdin is restored afterward.
- The same module's `_scope`: fixed already-decoded argument strings.
- `scripts/job_apply_store/io.py` `read_json_object`: a memory-backed path-shaped
  object opens an actual UTF-8 TextIOWrapper, and exposes only a synthetic label.
- `scripts/job_apply_workspace/http.py` `HttpMixin._read_json`: a memory HTTP
  receiver supplies the exact content type, byte length and BytesIO stream.

Direct operations are `json.loads(bytes)` and `json.loads(bytes.decode("utf-8"))`.
JSONL reproduces only the `line.strip()`/`json.loads(line)` branch in
`scripts/job_apply_store/domains/sessions/history.py`; it does not invoke the
history wrapper, event validation or filesystem behavior. No Store is opened.
CLI filename dispatch, real terminal decoding, HTTP authentication/network reads,
startup descriptor checks and filesystem permissions are outside this receipt.

| Reference | Unicode | Observation |
| --- | --- | --- |
| CPython 3.12.13 | 15.0.0 | Existing managed interpreter, explicit invocation; all 77 outcomes equal 3.14 |
| CPython 3.13.13 | 15.1.0 | Focused test passed all 77 outcomes |
| CPython 3.14.4 | 16.0.0 | Default and version alias passed all 77 outcomes |

All report recursion setting 1000; no caller recursion threshold was tested.
The ordinary focused run had four passing tests and one Python 3.12 alias skip.
The separate explicit 3.12 invocation closes reference availability for this
receipt without claiming that the skipped test ran. Integration can expose the
already available alias for a complete rerun. No interpreter was installed.

## Observed contracts

| Synthetic input | HTTP wrapper | UTF-8 document wrapper | UTF-8/strict stdin wrapper |
| --- | --- | --- | --- |
| UTF-8 object; object with CRLF whitespace | Accepted | Accepted | Accepted |
| UTF-8 BOM | Accepted | StoreError | StoreError |
| UTF-16LE/BE or UTF-32LE/BE without BOM | Accepted | StoreError | StoreError |
| UTF-16LE BOM or UTF-32BE BOM | Accepted | StoreError | UnicodeDecodeError escapes wrapper |
| UTF-8 encoded lone surrogate | Accepted and preserved | StoreError | UnicodeDecodeError escapes wrapper |
| Invalid UTF-8 | HTTP 400 | StoreError | UnicodeDecodeError escapes wrapper |
| Unescaped CRLF inside string | HTTP 400 | StoreError | StoreError |
| Array instead of object | HTTP 400 object error | StoreError object error | StoreError object error |

HTTP passes bytes directly to Python JSON detection and accepts more than UTF-8.
Replacing this with strict UTF-8 would change behavior. Document reads catch
UnicodeError, whereas `_read_input` catches only OSError/JSONDecodeError.
The stdin evidence specifies strict decoding; it does not establish the default
terminal or process stdin error handler on every platform.

Scope strings accept ordinary JSON whitespace and escaped lone surrogates, but
reject a leading BOM, NBSP prefix and non-object root with the existing scope
StoreError message. JSONL's branch skips empty, ASCII-whitespace, NBSP and em-space
lines; a BOM-only line reaches JSON decoding and fails. Broad Python `strip()`
behavior must not be replaced accidentally with JSON's four whitespace characters.

## Safety and verification

The reference refuses all arguments and nonempty stdin before capture. It accepts
no file/root/output option. All data is fixed and synthetic. Output contains only
closed case identifiers, provenance, exact synthetic success serializations,
exception class names and reviewed application messages. Interpreter exception
text is omitted because it can echo raw values; this omission is explicit and
does not establish interpreter diagnostic equivalence. Tests deep-compare every
outcome and reject additional fields or unexpected text. A nonexistent arbitrary
exception class fails capture rather than being converted into a passing receipt.

Focused command: `node --test tests_js/python_json_ingress.test.mjs`.
Size enforcement passed. Tests additionally verify rejection of caller arguments
and stdin without echoing the synthetic private-value canary.

## Remaining SEM decisions and evidence

- Actual caller-stack decode/encode recursion thresholds and propagated failures
  remain open; iterative TS capability is not equivalent evidence.
- Integer digit-limit failures, real CLI stdin encoding/error configuration and
  final CLI exception handling require separate caller-level contracts.
- Unicode matching differences across 3.12/15.0, 3.13/15.1 and 3.14/16 remain
  explicit; this identical ingress corpus chooses no matching profile.
- README promises Python 3 generally; CI uses 3.12. CI's selection alone is not
  a product declaration limiting supported behavior to that version.

This evidence supports designing distinct byte and text ingress adapters. It
does not authorize a new encoding policy, full matching acceptance or activation.
