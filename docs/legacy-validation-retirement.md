# Legacy validation retirement

The user approved removing the duplicate sequential validate job after run
33999840122 spent over eleven minutes in it. Parallel Python/browser suites,
policy, platform jobs and package-contract remain required by PR gate.
Affected selection remains shadow-only; full deterministic shards still run.

This supersedes the planned 20-PR legacy observation window. That target was
not completed and equivalence is not claimed. The temporary packaged CRUD
skip was removed too: the full journey remains in browser and package checks.
Its original browser-to-CLI failure is unresolved, not fixed by retirement.

Extra CLI invocations and standalone link checks in the legacy lane are also
removed; invocation-for-invocation equivalence is not claimed. Release/nightly
workflows are unchanged. Branch protection settings are unchanged. If external
rules require the removed validate context, an owner must update that rule to
the retained PR gate; do not bypass protection.
