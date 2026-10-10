# Combined workflow acceptance

These deterministic tests exercise the native canonical Store shared by the
experimental workflows. They use fictional local resumes, jobs, and authority
grants. They never load an owner Store, contact an ATS, or submit an application.

## Executable scenarios

Run the combined tests with:

```sh
node --test --test-concurrency=1 tests_js/workspace_combined_workflows*.test.mjs
```

| Test file | Verified boundary |
| --- | --- |
| `tests_js/workspace_combined_workflows.test.mjs` | Resume request, proposed facts, exact host-attested review, confirmed fact revision, canonical application run, preparation, claim, archived historical replay, and manual-review handoff. |
| `tests_js/workspace_combined_workflows.test.mjs` | Lost broker capability cannot be restored by replay. Explicit expiry recovery restores it; profile revocation blocks ordinary progress while permitting safe handoff. |
| `tests_js/workspace_combined_workflows_campaign.test.mjs` | Two jobs follow the canonical campaign order. Broker loss blocks moving ahead; pause survives reconstruction; stale control revisions fail; resume enables the second job; historical first-job replay preserves its capability. Native authority revocation blocks ordinary progress. |
| `tests_js/workspace_combined_workflows_browser.test.mjs` | A synthetic browser write loses its response. Its native persisted uncertainty survives boundary reconstruction, blocks a new operation ID, and resolves only by readback without another write. Native authority revocation denies replay and reconciliation. |

The extraction chain starts its application run through
`ApplicationRunsService.start` with the confirmed fact revision. It does not seed
a fabricated run selection. The archive capacity fixture adds valid historical
receipt entries to reach the threshold; subsequent compaction and replay use
the actual native archive implementation and canonical Store lock.

The no-write assertions include root documents, sessions, managed resume files,
and archive segment bytes. Profile preferences, unrelated resume facts, managed
resume metadata, and managed files must survive each combined flow. Workflow
and browser receipts must not contain resume text, profile values, or claim
bearers.

## Evidence limits

The browser test uses `ApplicationAuthorityService.evaluate` against the actual
native claim, run, grant, destination, and resume selection. Its fixture host
holds the returned native claim capability privately. The browser task binding
is a fixture host identity; this test does not install a production adapter or
connect the model transport to a live browser.

Reconstructing workflow and boundary objects demonstrates persisted state
reload. Dedicated claim, archive, extraction, and durable-browser crash tests
provide process-kill and interrupted-publication coverage. The synthetic adapter
represents an external form surviving boundary reconstruction; it does not
prove preservation of real browser drafts, live ATS behavior, authenticated
human approval, or an exactly-once browser write guarantee. Final submission
remains manual.
