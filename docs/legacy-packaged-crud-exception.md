# Temporary legacy packaged CRUD exception

User approved temporarily omitting the failing run on PR49. The legacy
`validate` job alone sets `JOB_APPLY_SKIP_LEGACY_PACKAGED_CRUD=1` for package
smoke. This skips the full named CRUD journey, not just its failed assertion.
Its creation/conflict/focus/readiness/trash checks therefore lose one duplicate
execution in that lane. The other two packaged browser tests still execute.

Default local/release smoke and the required `package-contract` job retain the
entire journey. The required browser shard and earlier legacy source-browser
run also retain it. No check is marked continue-on-error, and the aggregate gate
still requires all jobs to succeed.

The underlying failure in run `33987643707` was “browser-created job must be
visible to the CLI”. Its cause is unresolved; this exception is not a fix or
proof of flakiness. Restore the legacy invocation by removing the workflow
environment setting after diagnosis and verified repair, then remove the smoke
switch and this exception record. Do not count exempted runs as full legacy
equivalence evidence for the 20-PR observation gate.
