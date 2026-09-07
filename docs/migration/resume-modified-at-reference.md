# Resume modified-time reference

Coordinator-owned `allowed_files`: this document,
`tools/contracts/resume-modified-at/reference.py` and
`tests_js/resume_modified_at_reference.test.mjs`. validation_strategy independently
reviewed the reference before freezing; no dependent timestamp implementation is
accepted by this document.

The driver calls the actual `_resume_modified_at` function. Twenty-four fixed
fixtures bind exact binary64 input bits, output strings or exception categories.
They cover signed zero, positive/negative seconds, microsecond rounding and second
carry, recent timestamps, years 1 and 9999, out-of-range values, NaN and infinities.
There are 23 distinct bit patterns: two recent decimal fixtures intentionally
collapse to the same binary64 value. Python rounds to microseconds before
formatting seconds; flooring seconds or using a millisecond Date directly would
lose observed behavior.

Four additional cases set exact nanosecond mtimes on an owned temporary file,
then capture actual stat float bits and formatted output. They include negative
600 nanoseconds: the native stat float differs from the directly supplied
decimal float `-0.0000006`. File content, size, mode and mtime remain unchanged
during observation. These exact native conversion checks fail closed if another
filesystem rounds differently; they do not silently normalize away differences.

Each capture binds the production source hash and interpreter/platform profile.
Caller arguments and input are rejected; no caller files or live Store are used.
Run `node --test tests_js/resume_modified_at_reference.test.mjs` with the installed
Python 3.12, 3.13 and 3.14 aliases. Windows native timestamp behavior remains
unverified. The default interpreter duplicates a versioned profile's evidence.

This bounded reference does not cover every representable float, all calendar
boundaries, malformed metadata objects, property access errors or all native
nanosecond-to-float conversions. Those obligations remain for the timestamp and
observation implementations and their broader independent tests.
