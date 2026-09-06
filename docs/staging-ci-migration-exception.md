# Temporary staging CI exception

Approved by the repository owner on 2026-09-06 to unblock the TypeScript
migration. PR49 may merge without a successful final CI run. This is an explicit
exception, not evidence that the full suite passes or that the original
browser-to-CLI issue is resolved.

Validate Plugin runs automatically only for main pushes and PRs targeting main.
Staging validation is manual through workflow_dispatch; all validation jobs
remain available. Manual runs use HEAD~1 as the base-relative policy reference.
Nightly and release workflows are unchanged.

The staging-protection ruleset temporarily has no required status checks.
Its PR requirement, deletion protection and force-push protection remain active.
Main rules and bypass permissions are unchanged. Previously required staging
contexts were validate, windows-store-workspace, macos-credential-helper and
macos-account-flow-helper. The validate context was already retired and must
not be restored as a requirement without restoring the job.

During migration, each implementation must pass local test:fast, relevant
focused tests, check:size, and relevant TypeScript build/type checks before
integration. Record failures and platform gaps explicitly; never count skipped
or unrun checks as passing. Python remains the only live Store writer.

Before production cutover, restore automatic staging triggers and required
checks using the current PR gate and verified platform contexts. Run complete
validation on the integrated branch before release. Restoration is an explicit
integration-owner task, not an automatic claim that migration is complete.
