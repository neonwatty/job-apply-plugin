# Actual pipe stdin JSON evidence

The fixed synthetic harness invokes the production Store `_read_input("-")`
through its facade and the policy `_read_input("-")` through its facade in child
Python processes. Payload bytes arrive through a real subprocess stdin pipe.
The harness never replaces `sys.stdin`, opens a Store or executes CLI dispatch.
It imports parser functions only. No caller input or file path is accepted.

Run `node --test tests_js/python_json_stdin.test.mjs`. The reference can also emit
its fixed receipt with `python3 -I tools/contracts/json-ingress/stdin-reference.py`.
Tests use existing versioned executables on PATH. The verification run used a
temporary python3.12 alias to the already-installed interpreter; no interpreter
was installed or changed and no developer-specific path is checked in.

## Observations

Five tests passed with zero skips. Each distinct profile below produced 28
outcomes: fourteen fixed byte payloads through two production readers. The
default python3 repeats the 3.14 profile and adds no independent profile.

| CPython | Unicode | Actual stdin | UTF-8 mode | Recursion setting |
| --- | --- | --- | ---: | ---: |
| 3.12.13 | 15.0.0 | utf-8 / surrogateescape, pipe | 0 | 1000 |
| 3.13.13 | 15.1.0 | utf-8 / surrogateescape, pipe | 0 | 1000 |
| 3.14.4 | 16.0.0 | utf-8 / surrogateescape, pipe | 0 | 1000 |

All three profiles agreed on these fixed cases:

- Valid non-ASCII UTF-8 survives as its original Unicode characters.
- Byte FF inside a JSON string is accepted and becomes U+DCFF.
- Bytes ED A0 80 inside a JSON string become U+DCED, U+DCA0 and U+DC80;
  this differs from the JSON byte decoder's surrogatepass interpretation.
- ASCII JSON escape `\ud800` remains a single surrogate value.
- UTF-8 BOM, UTF-16 BOM, invalid byte outside a string and raw string CRLF
  receive the application unreadable-object error; arrays receive object error.
- External CRLF whitespace is accepted. Duplicate decoded keys use the last
  value and preserve the final value's integer/float identity.
- Nested arrays of depth 64 and 2000 inside an object are accepted and serialized
  by both readers on these installations. A recursion setting of 1000 is not
  evidence of a JSON input depth threshold of 1000.

## Limits and remaining acceptance gates

This is the isolated-interpreter pipe profile (`-I`), with real standard input;
it is not a blanket strict-UTF-8 assumption. Tests deliberately fail if an executed
profile has an unfrozen encoding/error mode. Missing optional executable aliases
produce explicit unverified skips, never acceptance. Mandatory default execution
cannot skip. Child runs have three-second deadlines and fixed bounded inputs;
the test capture has a fifteen-second deadline and 128 KiB output limit.

It does not certify interactive terminal input, Windows console/pipe behavior,
locale changes, PYTHONIOENCODING overrides (ignored by -I), redirected-file CLI
paths, shell quoting, full dispatch, real Store mutations or the maximum accepted
depth. Interpreter exception text is not frozen; only application error messages
and safe exception categories are retained. Depth success spans decode and the
reference serializer, so a future failure needs stage-specific investigation.

The earlier in-memory strict stdin evidence remains valid for that explicit
wrapper profile but cannot represent this observed production pipe profile.
Likewise the scalar-raw-text typed JSON corpus does not cover these surrogateescape
transport outcomes. A production TypeScript stdin adapter needs an explicit
compatible byte-decoding contract before routing can change. SEM remains open.

Coordinator review tightened exact Unicode/UTF-8-mode profile assertions and
reran all five tests with zero skips. The full-tier test matrix now explicitly
registers this suite. These results do not accept untested platform profiles.
