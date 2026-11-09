# P02 host readiness — evidence preparation, not acceptance

Baseline reconciliation: `adb9fb9`. Current local observation: macOS 26.4.1,
arm64, Node 22.22.3, Unicode 17.0, runtime Node-API capability 10. Existing native
migration addons deliberately target Node-API 8; the runtime capability does not
change that binary contract. This is the developer machine, not a clean host.

The app's project listing exposes this project on the local host only. A project
or connection listing would not establish a clean baseline or native acceptance.
No remote machine, new VM, host installation, paid infrastructure, account or
live applicant data was used for this preparation.

Preserve the existing [support promises](../../runtime-support.md) and
[pending matrix](../../runtime-evidence/acceptance-matrix.md). The prior matrix
covers proposed Linux/macOS/Windows x x64/arm64 with Codex and Claude host columns;
none has accepted clean-host evidence. Before P02.V, distinguish Codex CLI versus
Codex desktop and each actually supported host/target combination, record exact
versions/minimum OS/libc requirements, and identify authorized clean test hosts.
An unsupported product/target must be explicitly excluded with reviewed evidence,
not counted as passing via another interface or a simulation.

README still describes workspace launch without a separately installed Node
runtime. Developer PATH availability cannot meet that product promise. B05 must
prove either a versioned host runtime contract or reviewed self-contained runtime
artifacts; launch-time downloads/builds are prohibited. No runtime distribution
choice or support narrowing is made in this preparation.

P02 therefore remains open for precise matrix/access decisions and independent
review. P05 and native acceptance stay dependent on it. Reference preparation,
evidence tooling and other ready portable work continue in parallel. The user's
grant covers local implementation/testing and gated staging PRs/merges; it does
not authorize new paid infrastructure or unrequested live-account operations.
