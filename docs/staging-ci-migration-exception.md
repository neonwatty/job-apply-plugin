# Restored staging CI gate

The temporary exception approved on 2026-09-06 ended on 2026-09-15. It allowed
PR49 to merge without a successful final CI run and did not count as evidence
that the full suite passed or that the original browser-to-CLI issue was resolved.

Validate Plugin now runs automatically for pushes to and pull requests targeting
both `main` and `staging`. Manual `workflow_dispatch` remains available and uses
`HEAD~1` as the base-relative policy reference. Nightly and release workflows
are unchanged.

The staging-protection ruleset requires the current aggregate `PR gate` context
and an up-to-date branch. Its PR requirement, deletion protection and force-push
protection remain active. Main rules and bypass permissions are unchanged. The
retired `validate` context remains retired; the aggregate gate requires every
current Linux, Windows, macOS, browser and package job.

During migration, each implementation must pass local test:fast, relevant
focused tests, check:size, and relevant TypeScript build/type checks before
integration. Record failures and platform gaps explicitly; never count skipped
or unrun checks as passing. Python remains the only live Store writer.

Before production cutover, run complete validation on the integrated candidate.
Restoring this gate does not by itself claim that migration or cutover acceptance
is complete.
