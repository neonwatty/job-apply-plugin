# Resume test data

`owner-like-redacted.pdf` is a realistic, one-page resume fixture for managed
resume import and future extraction coverage. It was derived from an owner resume,
then rewritten with fictional contact details, employers, schools, and dates. The
source resume is intentionally kept outside version control.

The fixture was manually reviewed as redacted and is pinned by this SHA-256 digest:

```text
aa5db02218f2eb40ab26521fb614b8bc86527fa11ee1c531b5555f6b54aad551
```

If the PDF changes, review the rendered document for personal information before
updating the digest in this file or in the automated test. Do not copy an
unredacted resume into this directory.

This fixture complements, but does not replace, the deliberately minimal
`qa/scenarios/*/synthetic-resume.pdf` fixtures. Those files have a stricter closed
content contract for deterministic browser replay and privacy validation.
