# Ink & blue UX foundation

Approved direction: compact website navigation, warm neutral surfaces, muted blue accents, readable sans-serif typography and consistent page structure. The owner-approved audit is in outputs/ux-audit/professional-ux-audit.md.

This work updates PR #65, still open, without merging or replacing owner walkthrough installations.

- [x] Add grouped dropdown navigation with a mobile menu, Escape/outside-click dismissal, active group/destination and deliberate page focus/scroll.
- [x] Apply Ink & blue light/dark tokens and compact headers across all eight pages; remove promotional-size typography and improve labels, buttons, notices, dialogs and responsive spacing.
- [x] Place readiness on Overview with an on-demand Facts panel; title follows selection. Preserve existing drafts, default views and all Store/approval contracts.
- [x] Adapt browser tests to explicit menu navigation; verify keyboard dismissal, responsive layout, focus/scroll, contrast and existing journeys.
- [x] Run affected suites, inspect a separately installed candidate, provide browser QA and exact commit receipt.

Implementation files: companion/workspace/index.html, styles.css, features/navigation.js. Reuse current navigation IDs/coordinators. Tests use a shared openWorkspace helper that opens the actual menu before selecting its destination. No test-only production behavior.

Later work remains explicitly tracked: library-first upload, direct preview without nested dialogs, human-facing answer scope/account settings, populated activity/conflict walkthroughs and full owner acceptance.

Validation: 11 affected suites passed against origin/codex/python-release. Four
additional light/dark desktop/mobile cases passed after the independent review
fixes, including Escape on the Menu button and text contrast for toast, selected
controls and Skip to workspace. A separate installed candidate uses only a
synthetic Store, with PDF and TXT examples. Owner visual acceptance remains open.

Owner cleanup: tighten the header to 56px; show the selected Facts tab as the
page heading; place readiness on Overview with an on-demand Facts panel; add a persistent
animated sun/moon toggle.
