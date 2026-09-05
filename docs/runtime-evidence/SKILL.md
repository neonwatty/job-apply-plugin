---
name: runtime-evidence
description: Disposable non-certifying runtime diagnostic for supervised host evidence runs.
---

# Runtime evidence diagnostic

This fixture is not a production skill or runtime launcher. Use only in an
explicitly authorized disposable evidence environment. Do not install this
fixture, change host configuration, authenticate, or download anything without
separate authorization. Never access an account, resume, browser, or Store.

Ask the supervising operator for the fixture repository location if unknown;
do not search the home directory. Through the host's ordinary command tool,
run the repository's `qa/runtime_launch_evidence.py` using an already available
Python interpreter. Supply `--host-claim codex` or `--host-claim claude` according
to the current host. First use `--environment inherited-path`, then
`--environment node-free-simulation`. Do not run a login shell, source a profile,
or supply developer PATH additions. If Python is absent, stop and report the
bootstrap prerequisite; do not install it.

Return only the closed JSON receipts. Do not include paths, environment values,
raw command output, tokens, or identity. Both receipts remain unverified even
when invoked by a host. The operator must independently document host/package
versions, clean-machine setup and actual invocation provenance in a non-private
evidence ledger. This fixture cannot certify fresh-host support or choose a
release strategy. A simulated missing Node result is not a clean-host test.
