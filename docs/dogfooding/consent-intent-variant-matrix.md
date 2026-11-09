# Consent intent variant checks

Run these checks with fictional answers before interpreting a new live form.
The saved answer is an intent about a specific purpose, data, recipient, and
consequence. The visible control only determines how an approved intent is
expressed. Semantic lookup returns candidates; it does not decide that two
notices have the same meaning or grant action-time consent.

| Form variant | Expected handling |
| --- | --- |
| Checkbox asks for the same stated purpose | After form-specific approval, check it and verify the checked state. |
| Radio group offers an unambiguous `I agree` choice for the same purpose | After approval, select and verify that choice. |
| Dropdown offers an unambiguous `Yes, I agree` choice for the same purpose | After approval, select and verify that choice. |
| Text field explicitly asks for `I agree` for the same purpose | After approval, enter the requested phrase and verify persistence. |
| Notice adds an advertising or third-party-sharing purpose | Treat as a new decision, even if its wording scores highly against the saved answer. |
| Notice changes the data, recipient, or consequence | Treat as a new decision. |
| Dropdown has only ambiguous options, or text box asks for a signature/name | Stop for the owner; do not improvise assent. |
| Saved decision is a decline and the form has a clear `No` option | With current-use approval, select and verify `No`; an empty required checkbox is not a decline. |

For each live ATS run, record which control types and notice changes actually
appeared. A platform run only covers the variants observed there. Stop at
manual review, and do not use a synthetic variant as evidence that a live ATS
control worked.
