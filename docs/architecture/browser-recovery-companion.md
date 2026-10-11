# Browser recovery in Companion

Companion's Automation panel shows a read-only summary of saved browser actions.
The authenticated `GET /api/browser-recovery` projection includes public counts
and closed recovery guidance. It excludes operation IDs, claim capabilities,
source values, approval receipts, browser contents, and credentials.

## User states

- **Loading:** the panel is checking stored history. It hides an earlier ready
  snapshot while a refresh is pending.
- **Unavailable:** the Store does not supply browser recovery metadata. The panel
  does not infer that history is empty or that automation can proceed.
- **Error:** status could not be verified. The user can refresh the read-only
  projection; the panel preserves the instruction not to repeat an uncertain action.
- **Ready:** no unresolved operation is recorded. This does not establish a live
  browser connection or grant approval to write.
- **Reconciliation required:** an earlier action has an uncertain result. The
  user keeps the browser draft open and asks the agent for a read-only check.
  That check needs an active protected browser host with current attempt access.
  When verification is unavailable, the user stops automation and takes over
  manually after reviewing the existing form.
- **Capacity reached:** automated writes stop. Manual handoff preserves the draft
  and history; deleting history or retrying the write is not a recovery action.

The panel explains recent action count, archived action count, and remaining
archive batches. Batch availability describes storage only, never write authority.
The panel offers one control: **Refresh browser status**. It cannot reconcile,
reset history, retry a browser write, grant consent, or submit an application.
Final review and submission remain human actions on the employer site.

## Implementation and checks

- `apps/companion/components/browser-recovery-model.ts` parses closed status/action
  pairs and nonnegative safe counts, selecting only public fields.
- `apps/companion/components/BrowserRecovery.tsx` renders the state and refresh
  control using the existing scoped, cancellable projection hook.
- `apps/companion/components/ApplicationAutomation.tsx` mounts the panel.
- `tests_js/workspace_browser_recovery_ui.test.mjs` exercises malformed payloads,
  privacy filtering, status wording, stale-readiness suppression, and the absence
  of browser mutation controls.
- `src/store/native-browser-recovery.ts` reads under the existing Store lock
  without journal recovery, temporary cleanup, or archive publication. Pending
  cross-document commits return unavailable until the owning workflow recovers.
- `tests_js/workspace_browser_recovery_native.test.mjs` checks preserved Store
  bytes, archive validation, and redacted failures.
- `tests_js/workspace_browser_recovery_ui_browser_support.mjs` extends the native
  Companion walkthrough with real endpoint access, controlled response states,
  narrow layouts, and preservation of unrelated form drafts.
