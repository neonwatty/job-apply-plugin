# Staging artifact contract reconciliation

Upstream staging `4f6fcbe` adds `skills` as the first entry of
`scripts/smoke/artifacts.py::CRITICAL_TREES`. The seven fixed critical files remain
unchanged. Recursive inventory, verification and copying now cover all files
under skills, including nested reference documents and other skill entrypoints.
This is an intentional upstream contract change, not a relaxation of migration
acceptance or a refreshed golden result.

The inert TypeScript inventory mirrors the exact tree order. Existing synthetic
fixtures now include `skills/job-apply/references/runtime-contract.md` and
`skills/job-search/SKILL.md`. Independent expected inventories, byte-copy hashes
and target paths include those files. Empty-tree fixtures retain required fixed
skill files while removing the additional skill files; their original fixed-only
inventory assertions remain meaningful. Copying fixed-only fixtures necessarily
creates the target skills parent, while unrelated empty critical trees still
remain uncreated. Existing failure scenarios and exact error assertions remain.

New native synthetic comparisons across Python 3.12/3.13/3.14 cover nested
reference discovery, tampering, removal, unexpected reference files, symlinks and
tampering with a newly covered skill entrypoint. Each comparison also asserts the
specific intended outcome independently and verifies that neither implementation
changes the fixture tree. Existing metadata/data-copy expected path sets name the
skills tree explicitly; their existing fixture files already created that parent,
so the expected file contents and failure boundaries do not change.

Root owns emission, registration, combined validation and the integration commit.
This package repairs staging integration only. It does not accept B04, activate
TypeScript against a live Store or change any release/host gate.
