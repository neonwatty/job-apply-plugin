# Focus Queue

Implemented on `codex/companion-design-focus-queue`, reconciled with staging
`f95b4947453ad6c6abc9cc0e81c3e443706d4714`.

## Design

Two blues: canvas `#F3F8FD`, white panels, ink `#172D49`, muted `#576B80`,
borders `#D5E3EF`, and selection fill `#E0F2FF`. Selection accents use exact
`#0096FF`; primary buttons use exact `#0000FF` with white text. Existing semantic
warning/error colors remain. Primary text contrast is 8.59:1, muted text on canvas
is 5.15:1, and dark text on selection fill is 12.14:1.
Trebuchet MS provides readable controls; Georgia gives review headings a quieter
pace. Both use local system fonts with fallbacks and no network font requests.

```text
Navigation rail | Page title and relevant actions
                | Attention queue | Decision context
                |                 | Open Job details
```

Left alignment, a persistent navigation rail, and a selectable queue make the
workspace about deciding what to do next. All existing sections remain reachable.
The first design pass rejected a metric-heavy dashboard; the implemented second
pass gives attention items an explicit selection and decision area. Screenshots
led to compact mobile navigation and corrected extraction-panel padding.
The sidebar now animates between an expanded menu and a 76px icon rail.
Mobile uses a compact icon menu. Native buttons preserve focus and accessible
names; hover/keyboard tooltips expose labels. Reduced motion removes visible
animation. All pages use shorter, precise copy without changing data contracts.

The UI uses actual server attention reasons, status, timestamps, blockers, and
handoff metadata. It does not infer urgency or introduce lifecycle states.
Selection is a local presentation change. Mutation, authentication, provenance,
revision conflicts, consent, draft protection, and final submission remain in
the existing workflows. Keyboard selection uses native buttons; selected items
expose `aria-pressed` and control a live decision region.

## Start isolated previews

From this worktree:

```sh
npm ci
npm run companion:build
node apps/companion/design-preview/start.mjs --port 4322 > /tmp/focus-integrated-preview.log
```

The launcher prints an authenticated loopback URL on port **4322**. Open that
URL, including its session fragment. Do not save the fragment in documentation.
The authenticated preview has also been opened in this chat's browser panel.

For a separate empty Store:

```sh
node apps/companion/design-preview/start.mjs --empty --port 4325 > /tmp/focus-integrated-empty.log
```

Every launch creates a fresh private temporary native Store and native lock
provider. Only fictional `example.invalid` jobs and synthetic applicant material
are seeded. The fixture launcher holds an exclusive process-owner lease; Ctrl-C stops both services.
Temporary fixture directories are retained under the operating-system temp
directory for inspection. No owner Store or account is used.

## Visual checks

To reproduce the screenshot pass, redirect each launch's output to
`/tmp/focus-integrated-preview.log` and `/tmp/focus-integrated-empty.log`, respectively, then:

```sh
node apps/companion/design-preview/inspect.mjs
```

Screenshots go to `/tmp/focus-queue-screenshots` (or the first script argument).
The check covers desktop and 390px mobile layouts, every main destination,
sidebar collapse/expand at 1440/1024/760/390/320px, focus and draft preservation,
reduced motion, queue keyboard selection, selected-job handoff, filtering, transient fetch
errors/retry, empty attention, extraction review, and horizontal overflow.
Only fetch-error visualization is browser-intercepted; populated and empty
screens otherwise use the native synthetic servers.

## Integration verification

The refreshed sidebar preserves staging’s cached pages, draft guards, refresh
keys, scroll restoration, consent defaults, accounts and sign-in, and settings.
The attention decision pane includes form checklists and live reconfirmation.
Verification is performed against staging with the affected suites, repository
commit/push hooks, production browser walkthrough, and independent branch review.
The scripts above reproduce the synthetic visual checks without owner data.

Saved screenshots in `screenshots/` show desktop/mobile attention, collapsed
navigation, Jobs, extraction review, and empty attention. Session tokens are never
saved in these documents or screenshots.
