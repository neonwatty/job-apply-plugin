### Workday

**Characteristics:**
- Multi-page wizard with heavy JavaScript
- Non-standard UI components (custom dropdowns, date pickers)
- Requires a tenant-host account realm; use [Account Setup](../../account-setup/SKILL.md) for value-free local metadata

**Approach (visible browser first):**
1. If login, CAPTCHA, MFA, or account creation is required, pause for the user. Account Setup may configure redacted local metadata, but only the user handles the live account and macOS Keychain credential.
2. Navigate through "My Information" → "My Experience" → "Application Questions"
3. Read the visible form structure on each page
4. For dropdowns: open the field, read the visible options, then choose the supported value
5. For date fields: May need to click calendar icon, then select date
6. Use "Save and Continue" for intermediate steps, but stop before "Submit" or any equivalent final action
7. Upload the resume through the visible file control and verify the filename

**Special handling:**
- Workday dropdowns: Click field → wait → read the visible options → click the supported option
- Date pickers: Inspect the actual month/year or full-date control. Verify the resulting visible date; never assume MM/DD/YYYY. Follow the bounded control fallback in [field verification](field-verification.md).
- Required fields marked with asterisk or red border after validation

---

## Bounded recovery and progress evidence

Use [ATS recovery](ats-recovery.md) for opaque save errors, session expiry,
unsupported controls, and next-page failures. A signed-in header is insufficient
session evidence. Workday error IDs such as `I|…` are opaque correlation tokens,
not field diagnoses. Changing IDs never grants another retry.

## Segmented dates and selection pills

Use the host's documented accessibility controls first. In Codex, inspect
`tab.ax.get()` / `write()` and locate the exact section, From/To group and
Month/Year segment. An AX **stepper (settable)** is not an ordinary textbox.
For a fresh permitted entry, use `tab.ax.setValue(index, canonicalSegment)` on
that observed segment, then `tab.ax.pressKey(null, 'Tab')` to commit/blur and
inspect again. Reacquire the index after every rerender. Compare all segments of
that date after blur, including an unchanged month when editing a year; require
no associated Invalid Date error. A year-only education field stays year-only.
Do not append digits with `pressSequentially` to an unknown existing value.

If setValue is unsupported, inspect before any alternate. Only a current visible
mismatch and remaining control budget permit one alternate: focus the observed
segment, select its existing text, replace using the host's documented keyboard
or paste action, commit and reobserve. Use a calendar only if actually exposed;
never guess calendar buttons or repeat arrow presses toward an unknown year.
Exhausted retries remain exhausted across claims and candidate changes. A new
explicit owner-authorized trial of a tested method is a bounded supervised
intervention, not a reset of saved recovery counters; if the broker rejects the
operation, stop and report it. Never auto-retry a failed readback.

For Field of Study, inspect the current selected pill and its visible remove
button or exposed secondary action. Remove only that wrong selection, verify
its absence, then search and select the exact supported option and verify the
new pill after the menu closes. Do not send Delete/Backspace to a container or
infer success from an empty search box. If removal is unavailable, hand off the
specific control. Optional fields may be blank, but wrong existing values must
be corrected or explicitly included in the review blockers.

Use [field verification](field-verification.md) after **each** write, not after a
batch across unrelated fields. Keep write and observation errors separate.
`inputValue()` is not in the Codex host locator API; a TypeError from an invented
method says nothing about whether typing succeeded. Read the current AX state,
or use a supported screenshot for masked values. Do not bypass redaction.
