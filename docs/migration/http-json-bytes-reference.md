# HTTP raw JSON bytes reference

This bounded evidence captures 39 fixed synthetic requests through the actual
`HttpMixin._read_json` method. It opens no server, invokes no route or Store,
and accepts no caller body, path, argument or stdin data.

Allowed files are `reference.py` and `support.py` under
`tools/contracts/http-json-bytes`,
`tests_js/http_json_bytes_reference.test.mjs`, and this document.

## Bound production scope

The driver extracts the exact `_read_json` AST from
`scripts/job_apply_workspace/http.py` with explicit globals `json`, `HTTPStatus`,
`Any` and the actual `MAX_BODY_BYTES` expression from the workspace constants.
It separately extracts actual `_canonical_json` and the `encoded` assignment
from `_append_history_event_idempotent_locked`, binding `runtime_json` to real
Python json and `event` to the decoded synthetic object. It does not replace
these expressions with a reference reimplementation.

The receipt binds all four production files by SHA-256, plus the selected
interpreter's json, decoder, encoder and scanner source hashes. Provenance also
binds the resolved interpreter executable path/hash, loaded _json extension
origin/hash (or explicit built-in origin), and native byte order. Tests verify CPython
version family, platform, closed shapes, exact input bytes, headers, requested
read sizes, unread bytes, errors and downstream results. This is extracted-method
and encoding-expression evidence, not route or persistence integration. The
encoder's actual strict UTF-8 conversion runs in memory; no write is attempted.

## Semantic findings

Raw bytes ED A0 80 ED B0 80 within a JSON string are accepted and yield separate
Python codepoints D800 and DC00. An ASCII escaped pair or valid UTF-8 scalar
instead yields codepoint 10000. Mixed raw/escaped neighbors also preserve the
two separate surrogate codepoints. Lone raw and escaped surrogates survive
parsing; UTF-16 and UTF-32 surrogate payloads are also covered.

Object keys expose an observable equality distinction: a raw pair and a scalar
remain two different Python keys; an escaped pair and scalar collide, leaving
the last value. The receipt encodes strings and keys as integer codepoint arrays,
never as JavaScript strings that could silently merge these identities.

Actual canonical JSON retains these distinctions in its codepoint sequence.
Actual persisted-history encoding raises UnicodeEncodeError for surrogate
codepoints, including separate literal pairs. Valid scalar values encode
successfully. Tests bind the complete rejected string codepoints, error range,
encoding and reason. Rejection at this encoding expression does not prove the
value cannot reach an earlier canonical comparison in a real caller.

The corpus also captures UTF-8 BOM, UTF-16/32 BOM and inferred byte order.
Native-order BOM fixtures follow the recorded host byte order; explicit LE/BE
fixtures remain fixed. It also covers
malformed UTF-8/16/32, invalid JSON, non-object JSON and empty bodies. Content-Type
must equal application/json exactly. Missing/malformed/negative lengths return
411; oversize returns 413 before any read. Whitespace and plus in the length are
accepted through int conversion. A smaller length leaves trailing bytes unread;
a larger declared length with a complete shorter body is accepted by this
method. A short underlying read is not retried. An injected OSError propagates.
These observations are method behavior, not general HTTP framing guarantees.

## Validation and limits

Focused command: `node --test tests_js/http_json_bytes_reference.test.mjs`, with
the existing Python 3.12 alias on PATH. Observed native macOS arm64 result:
five tests passed, zero failures/skips; 39 cases on CPython 3.12.13, 3.13.13 and
3.14.4. Default python3 repeats 3.14.4 and adds no independent profile. Execution
is bounded to ten seconds and 1 MiB per reference process. Missing version aliases
are explicit skips; the default interpreter is mandatory.

No universal Unicode-scalar ingress restriction is established. Existing TS
plain-string representation cannot distinguish all admitted Python values here;
a test-only normalization would conceal the gap. Representation, caller-wide
compatibility, real HTTP framing, authorization, route integration, persisted
mutation and native host acceptance remain separate work. Independent review
and immutable freeze are required before downstream use.
