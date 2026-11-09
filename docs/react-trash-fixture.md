# React Trash fixture

The standalone `Trash` component accepts a stable `TrashClient`, explicit
per-type restore/delete capabilities, a `dirtyChanged(boolean)` callback, and
an optional `onMutation()` callback for other mounted canonical views. The
component reports pending confirmation and mutation as dirty. The parent must
retain its existing navigation/unload guard and memoize the adapter.

`createTrashClient(token, capabilities)` uses the same session token provided by
Companion, authenticated same-origin requests, no-store caching, cancellation
and a 30-second deadline. It does not read or create global auth state. Revisions
are parsed through the existing Python-compatible integer parser and retained
as bigint. Mutation requests contain only the exact `expectedRevision` integer;
recordless successful delete responses are supported.

Companion integrates the Trash tab, memoized adapter, capability selection
and styles with its existing navigation guard. `onMutation` is optional because other tabs unmount and reload on entry.

## Capabilities and recovery

Compatibility and native fixture modes support restore and permanent deletion
for jobs, resumes and answers. `nativeTrashCapabilities` enables all three record
types. Unsupported actions in any future capability profile remain disabled in
the UI and are independently rejected by the adapter before transport.

Restore uses a confirmation dialog. Permanent deletion requires the exact legacy
phrase `DELETE JOB`, `DELETE RESUME`, or `DELETE ANSWER`. A resume deletion
explicitly discloses managed-file deletion. Counts are advisory; the canonical
server is authoritative. The UI displays only labels, types and count summaries,
never incidental record values, paths, URLs, or raw server errors.

Every mutation error discards the confirmation and invalidates list authority.
Actions stay disabled until an explicit refresh succeeds. This includes unknown
outcomes where storage may have changed before the error. Conflicts never retry.
A successful mutation followed by a failed refresh remains explicitly saved;
it must not be replayed. Failed initial load never renders an empty-state claim.
Aborted or superseded reads cannot replace the current snapshot.

## Focused verification

Run `node --test tests_js/workspace_react_trash.test.mjs` and
`npm run companion:typecheck`. The focused tests cover exact large revisions,
malformed projections, redaction, fixed routes/bodies, recordless deletion,
capability enforcement, safe error guidance and no automatic transport retry.

`reactTrashBrowser(page, { origin, headers })` from
`tests_js/workspace_react_trash_browser_support.mjs` requires an authenticated
production Companion page backed by a **disposable Python Store** and the shared
wiring applied. It creates synthetic jobs, a managed resume and an answer using
the API; restores and permanently deletes all three through the UI; verifies
stale-revision rejection, typed confirmation, keyboard focus, advisory reference
errors, saved-mutation/failed-refresh recovery, redaction and 390px/desktop
layout. It also verifies native capability enablement, failed-load versus empty state,
and an error returned after a real restore commits. Reference and refresh-error envelopes are injected in the isolated page;
ordinary lifecycle and revision-conflict requests use the real Python backend.
The caller owns browser/service/Store cleanup. Do not run against live data.

Production build/browser evidence is worker readiness, not native migration or
release acceptance. The coordinator owns shared-suite integration, catalog
ownership, final review and staging integration.
