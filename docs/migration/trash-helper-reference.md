# UI0 trash presentation reference contract

This package captures unchanged JavaScript behavior only. No TypeScript port,
application import, deletion authority or production activation is introduced.

Allowed files:

- `tests_js/workspace_trash_reference.test.mjs`
- `docs/migration/trash-helper-reference.md`

The authoritative exports are `typedDeletePhrase`, `filterTrashItems`,
`trashBlockerText` and `lifecycleErrorText` in `workspace/lib/helpers.js`.
Their existing public identities are recorded in
`config/migration/browser-lib-03-surfaces.json`. The new test imports that module
directly and asserts hand-authored fixed expectations; it does not reproduce
the implementation as a second algorithm or derive expected results at runtime.
The existing `tests_js/workspace_helpers.test.mjs` remains unchanged.

## Required family scenarios

| Test identity suffix after `trash-reference:` | Evidence |
| --- | --- |
| delete phrases retain falsy defaults and String coercion | Missing/null/falsy inputs, whitespace, Unicode case expansion, numbers, symbols, arrays, objects and conversion error |
| filtering preserves order, item identity and strict type matching | Matching/nonmatching types, no-filter copy, original item references, strict equality and input preservation |
| missing collections and malformed elements keep existing behavior | Empty defaults, new empty arrays, null elements with/without filter, invalid collection errors and sparse array iteration |
| blockers sum integers only without clamping negatives | Singular/plural/zero, negative/cancelling counts, fractional/nonfinite/string/bool/BigInt exclusion, inherited properties and unsafe integer behavior |
| lifecycle messages preserve defaults, coercion and count suffix | Missing message, exact suffix text, nonstring coercion/errors, negative/cancelling/noninteger counts |
| revision conflict takes precedence without consulting other fields | Exact conflict copy, case-sensitive code, throwing getters prove message/count fields are not read |
| presentation functions leave frozen caller records unchanged | Frozen counts, records and arrays survive all four calls without mutation |

Fixed inputs and expected outputs are embedded readably in the test file. All
records and messages are synthetic. The unusual coercions and negative-count
text are observations to preserve, not new validation rules. Error assertions
freeze error class rather than interpreter-specific engine wording.

## Applicability proposed for independent review

Filesystem writes, durable recovery, crash interruption, native permission cells
and concurrent-writer scenarios are inapplicable to these four pure presentation
exports: they neither import adapters nor perform IO, schedule work or acquire
authority. This rationale does not apply to Trash deletion handlers or lifecycle
operations, which retain their separate required behavioral/platform gates.

Privacy evidence here is limited to using synthetic fixtures and proving input
nonmutation and conflict-message precedence. `lifecycleErrorText` intentionally
displays its provided message; it is not a redaction boundary. These tests do not
claim end-to-end privacy, safe deletion, browser integration or parent UI0
acceptance. Source classification and the applicability rationale require the
coordinator's independent review before family acceptance.

## Focused verification

Run `node --test tests_js/workspace_trash_reference.test.mjs`.
The coordinator owns test-matrix registration, source/contract hashes, immutable
revision binding and independent acceptance receipts. Missing registration or
receipt fields must remain explicit rather than inferred from a test exit code.

Independent review by numeric_codec verified all seven tests and the unchanged
source. Applicability applies to helper-owned behavior on ordinary presentation
inputs; caller-defined getters/coercion hooks can themselves have effects.
Reference tests are registered by the existing node-workspace-other workspace
pattern. No bootstrap imports or Store access occur in this package.
