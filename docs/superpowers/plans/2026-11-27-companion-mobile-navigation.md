# Companion mobile navigation plan

Base the work on merged `main` at `d4dbfcfc`. Keep the previous mobile QA worktrees available for comparison.

## 1. Navigation

- Replace the phone header menu with persistent Needs Attention, Jobs, and More destinations. Show the current destination, the attention count, and appropriately sized touch targets. Reserve space for the bottom bar and phone safe area.
- Put Overview, application data, and account controls on a grouped More screen. Keep the existing access rules for native and compatibility workspaces.
- Default portrait tablets to the compact rail and leave the wide desktop rail expandable and collapsible.

## 2. Needs Attention

- Put the company, role, and reason on each queue row. Open a focused view with the guidance and the job action on phones. Keep the list and decision side by side on larger screens.
- Return to the originating row after drilling in. Keep the reason filter active, and handle a queue item that has already been resolved or moved since the page loaded.
- Exercise a normal review handoff as well as submission verification and receipt reconciliation using independent fictional records.

## 3. Jobs

- Fit the title, New job, search, and Filters into a compact phone header. Collapse active-run information to a summary with expandable details.
- Prioritize role, company, and status on each mobile row. Keep secondary job information available in job details.
- Verify long role titles, empty and filtered lists, active runs, and a list long enough to scroll.

## 4. Browser history

- Give workspace sections, selected queue items, and saved job details addressable locations. Keep authentication in its existing fragment and storage flow.
- Handle Back and Forward, including from a job opened from Needs Attention. Restore list scroll and focus, and keep filters in the mounted workspace.
- Preserve job revision checks and edit conflict behavior. A canceled discard prompt must leave the user on the same draft. Handle a stale job ID and a direct link with no preceding list.

## Verification and preview

- Run the Companion build and affected suites. Exercise phone and portrait-tablet layouts in browser tests, including keyboard focus, history, narrow widths, and the existing desktop flow.
- Serve a separate synthetic workspace through a private Cloudflare quick-tunnel link. Keep Submission Lab out of this design pass and use the shipped job and Settings surfaces for submission-related QA.
