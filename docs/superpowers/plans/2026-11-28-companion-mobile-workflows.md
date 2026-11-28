# Companion mobile workflow improvements

Update the Companion mobile navigation worktree and use the existing More layout as the entry point. Work through the screens in order of the problems found in the 320 px and 390 px walkthrough. Keep the current Store contracts, explicit consent, and the shipped Submit after approval behavior.

| Screen | Change | Acceptance check |
| --- | --- | --- |
| Answers | Move search above library chrome and compare new drafts to their actual initial values. | An untouched drawer closes quietly. Declining a discard prompt after an edit preserves the draft. |
| Consent defaults | Reuse the draft handling, put search first, and group the returned records by purpose. | Records keep their original identity, scope, redaction, and review status under the correct purpose. |
| Overview | Compact the phone header and lead with the next action. Name the resume-facts destination in the button. | The initial 320 px viewport contains the complete next-action button, and the button opens the intended workspace. |
| Needs Attention | Move the action before the timestamp and secondary details. | A review, verification, or receipt opens the right job and returns to the same queue item. |
| Jobs | Display the active status by name in the filter control. | Search and status survive opening a job and going Back. Long status labels wrap without causing horizontal scroll. |
| Facts | Put search before revision metadata and add a phone reading state with an explicit Edit facts control. | Read-only cards can expand nested values before editing, and search still filters the cards. The existing editor retains numeric values, revision conflicts, provenance, and drafts. |
| Resumes | Give Import resume the main slot and group Refresh and Resume extraction under actions on phones. | The first saved résumé is visible without scrolling at 320 px. Both secondary actions are reachable. |
| Settings | Separate browser, application, and advanced preferences and put the save actions on one row. | Preferences still save through the existing form. The expanded settings fit at 320 px. |
| Automation | On phones, step through mode, eligible jobs, and confirmation of scope, duration, and exact permissions. | Eligible jobs appear first. Back preserves choices. Only the confirmation step can send a write. Active runs still expose their existing controls. |
| Accounts & Sign-in | Put Add portal beside the readiness summary. | The action takes the user to the existing form. Cancel closes it and returns focus. |
| Trash | Compact the header and lead with the empty state or record list. | Existing restore and permanent-delete confirmation behavior holds. Recovery guidance appears at the point of action. |
| Extraction review | Bring the résumé picker beside its request action near the top. | At 320 px, both controls appear together above the bottom bar. The button stays disabled until an eligible managed résumé is selected. |

## Implementation order

1. Fix draft tracking in Answers and Consent defaults. Exercise clean dismissal, unsaved edits, release of navigation guards, and consent retention before changing the list presentation.
2. Improve the workspaces reached from More, then check the main actions in Overview, Needs Attention, and Jobs. Preserve each action’s existing route and restore focus or filter state on return.
3. Split Automation approval on phones. Keep the original authority request and revision checks. Verify mode and job selection through Back, confirm the scoped request, and exercise the active campaign controls with fictional data.
4. Build the standalone Companion and run type, source-size, and affected checks. Walk all destinations at 320 and 390 px in WebKit and Chromium and check the 768 px tablet layout. Capture screenshots of the key interactions.
5. Run the final build in an authenticated Cloudflare preview backed by a separate fictional Store. Verify that the private entry link opens the preview and exercise the critical phone paths on that same build before sharing. Keep the previous shared preview available during verification.
