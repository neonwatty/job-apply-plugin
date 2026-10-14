# Value-free field verification

Use the installed `apps/companion/field-verification.mjs` helper's
`decideFieldVerification` export when interpreting an editable control's readback.
It classifies host observations; it does not read the browser or independently
prove a value. Keep applicant values, screenshots, filenames, paths, and raw
readback out of its inputs, outputs, Store receipts, and summaries.

Privately compare the current visible control with the intended canonical value.
Pass only this closed evidence object:

```js
const evidence = {
  source: 'readback',
  observation: 'masked',
  freshness: 'current',
  attemptScope: 'same',
  formScope: 'same',
  controlScope: 'same',
  repairCount: 0,
};
const decision = decideFieldVerification(evidence);
// verified: false; next: 'inspect_visual'; repairAllowed: false
```

The closed fields are:

| Field | Allowed states |
| --- | --- |
| `source` | `readback`, `visual`, `write` |
| `observation` for readback | `match`, `mismatch`, `masked`, `unavailable`, `unknown` |
| `observation` for visual | `match`, `mismatch`, `unreadable`, `unknown` |
| `observation` for write | `attempted` |
| `freshness` | `current`, `stale`, `unknown` |
| Each scope field | `same`, `different`, `unknown` |
| `repairCount` | `0`, `1` |

`current` means inspected after the latest write or action that could rerender the
form. Each scope attests comparison against the active attempt, exact form
instance, and exact control. Do not infer those assertions from a previous chat's
browser handle or earlier successful fill. Unknown scope or freshness requires
reinspection. The repair count tracks the control's bounded entry loop; never
reset it merely to obtain another repair recommendation.

## Follow the decision

- `continue`: only an affirmative, current, same-scope private comparison yields
  `verified: true`. This verifies one control, not the whole application.
- `reobserve`: inspect the actual current control; a write result, stale evidence,
  or evidence from another attempt, form, or control cannot verify it.
- `inspect_visual`: literal `<redacted>`, masking, omitted readback, and unknown
  readback are unobservable. Never compare the placeholder to the intended value
  or retype because of it. Use a supported current screenshot of that control for
  a private comparison. Do not bypass the host's redaction through another API.
  A masked, clipped, or unreadable screenshot maps to visual `unreadable`.
- `repair_once`: a demonstrable current mismatch permits one safe alternate entry
  under the existing consent and browser rules. Then inspect again with
  `repairCount: 1`; the attempted repair itself is never success evidence.
- `owner_input_required`: preserve the draft and use the `unsupported-control` /
  `owner-input-required` Browser action required handoff. The saved answer is
  already known; do not ask the owner to repeat it in Companion.

When supplying optional `fieldVerifications` to the readiness packet builder,
pair each existing non-file control ID with its `evidence`. Do not mark an
unverified required control complete or reuse an old visual match after a
rerender. Resume attachments use the separate upload verification contract.
Final submission always remains manual.
