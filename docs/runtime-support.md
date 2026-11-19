# TypeScript runtime launch gate

Status: **native artifact selected for macOS arm64, Linux x64, and Windows x64**. The installed
runtime uses stable Node.js 22.0.0 or newer, with TypeScript compiled to
JavaScript ES modules targeting ES2022. Each supported package carries a
verified Node-API 8 lock artifact. Other host cells remain unsupported.

The installed launcher, Store, task, attempt, policy, workspace, and QA replay
surfaces are native TypeScript. The assembled runtime fixture contains no Python files or Python launch path.
Marketplace installers can also retain a full source checkout, including Python
reference files. Those files are development evidence, not installed production
routes; their presence does not require a Python interpreter.

## Operating requirements

Node must already be available in the host's launch environment. The plugin ships
its native lock addon, not a Node interpreter, and never downloads Node or
compiles that addon on the owner's machine. Store/CLI operations need no npm
installation. A source-only Companion install needs npm and registry access on
first launch to build its server; subsequent launches reuse the build until a
plugin refresh. A prepared build does not need a new dependency download merely
to start. No Python runtime is required for installed workflows.

The supported package cells are macOS arm64, Linux x64, and Windows x64. CI
exercises clean locked dependency installs, native Store/CLI/browser checks and
isolated Codex/Claude installation on the POSIX cells; the Windows cell runs the
installed-entrypoint journey (Store, task, attempt broker, recovery, and review
handoff). This does not establish a host guarantee that Node is preinstalled or
live ATS/account acceptance.

### Windows x64 mapping

The Windows artifact is built from `native/windows/flock.c` and keeps the POSIX
contracts with Windows primitives:

- Exclusive non-blocking advisory locks use `LockFileEx` on one sentinel byte past
  any real file size, so locked lock/PID files stay readable.
- "Private and owned" (`0700`/`0600`, owner uid) is a protected DACL granting only
  the current user, applied where Store, candidate, and broker directories are
  created and inherited by every entry inside. Root validation checks that DACL.
- The attempt broker listens on a per-user, per-Store named pipe. Pipes cannot
  half-close, so the newline-terminated frame marks a complete request there.
- Directory `fsync` is skipped (NTFS journals directory metadata); file contents are
  still flushed. Writer switching re-verifies the retained Store after its rename,
  because Windows cannot rename a directory while handles inside it are open. See
[testing](testing.md) and the [transition guide](typescript-transition.md).

## Development probe

Run from the repository or a disposable installed fixture:

```text
node tools/probe-installed-runtime.mjs
```

The probe invokes `node --version` without a shell, with a two-second timeout
and 256-byte output limit. It removes Node preload environment settings from
the child. It reads no Store or account data and performs no installation or
network request. Its only output is this closed receipt:

```json
{"platform":"darwin","arch":"arm64","nodeAvailable":true,"nodeVersion":"22.0.0","launchMode":"node-candidate"}
```

`platform` is `linux`, `darwin`, `win32`, or `unknown`; `arch` is `x64`, `arm64`,
`ia32`, `arm`, or `unknown`. `nodeAvailable` means the version command completed
with a recognized stable version, not that a plugin can launch. An older stable
runtime reports its version with `launchMode: "unresolved"`. Missing, denied,
timed-out, malformed, prerelease, or noisy commands report `false`, `null`, and
`"unresolved"`. Unknown platforms/architectures always remain unresolved.
`"node-candidate"` means only that the observed version meets the provisional
floor on a recognized platform/architecture; it is never a release selection.

The receipt contains no executable paths, environment variables, raw errors,
stdout/stderr fragments, or user identity. A failed probe still emits a receipt;
automation must inspect its fields rather than interpreting exit zero as a
passed deployment gate. Running this `.mjs` probe itself requires a bootstrap
Node interpreter. Consequently, a clean host with no Node requires the host
evidence runner to record that absence; this probe cannot bootstrap itself.

Local development observation on 2026-09-05: `darwin`, `arm64`, Node `22.22.3`,
`node-candidate`. The synthetic tests cover missing, denied, timeout, output
limits, older stable, supported stable and malformed/prerelease versions. This
observation used the existing development environment; no fresh host-native
installation or supported-platform acceptance was performed.

## Historical launch research and evidence limits

### Node-independent evidence harness

With an already available Python interpreter, run:

```text
python3 qa/runtime_launch_evidence.py --environment inherited-path
python3 qa/runtime_launch_evidence.py --environment node-free-simulation
```

On Windows use the available Python command; do not install prerequisites as
part of the diagnostic. This harness invokes only a resolved `node --version`,
with a temporary working directory, no shell or stdin, a two-second process
timeout, and 256-byte limits on each output stream. Only PATH and Windows/temp
process prerequisites are passed to the child; Node preload variables and HOME
are excluded. It writes no Store data and deletes its temporary directory.
The Node-free simulation never resolves or launches Node, including on Windows
where executable lookup can otherwise consult the working directory.

Receipts contain only `schemaVersion`, `platform`, `arch`, `environment`,
`hostClaim`, `provenance`, `freshHostVerified`, `nodeAvailable`, `nodeVersion`,
`nodeStatus`, and `launchMode`. Status is candidate, unsupported, unavailable,
timeout, or invalid-output. A candidate meets the provisional version floor
only. Every result has `provenance: "unverified-self-report"`,
`freshHostVerified: false`, and `launchMode: "unresolved"`. Supplying
`--host-claim codex` or `--host-claim claude` cannot change those restrictions.
Exit zero means a receipt was emitted, not that a deployment gate passed.

The disposable `docs/runtime-evidence/SKILL.md` provides host-invocation
instructions, not automatic installation or trusted attestation. It lives outside
`qa/fixtures`, which is reserved for validated replay JSON artifacts. Local shell
observations and Node-free simulations remain development evidence. Actual
clean-machine setup and host invocation must be independently recorded by the
operator; the harness cannot infer them from arguments or environment variables.
Python absence is a bootstrap prerequisite, not evidence of Node absence.

### Evidence required to expand platform support

For each proposed supported OS/architecture, test both Codex and Claude using
fresh host-native installations on Linux, macOS, and Windows. Record the exact
host/package versions in a separate non-private evidence ledger. Start the
plugin through the host's actual launch mechanism, with a clean environment
that does not borrow a developer shell's PATH or Codex workspace dependencies.
The local probe alone cannot satisfy this gate.

Verify version detection, missing/unsupported runtime handling, fresh install,
upgrade, offline launch, rollback, child-process behavior, and installed module
inventory. Use disposable synthetic Stores and preserve privacy and permissions.
If Node is guaranteed by the chosen host contract, document that contract and
the exercised minimum version. Otherwise evaluate signed standalone artifacts
for each supported OS/architecture, including packaging, signing and upgrade
evidence. The installed runtime never downloads Node or compiles a native addon. A
source-only Companion installation explicitly runs pinned npm installation and
its local standalone build on first launch; this requires npm and registry access.

The selected release requires an existing Node runtime. A future host guarantee
or signed standalone runtime needs its own acceptance evidence. The diagnostic
`launchMode` does not select or certify either strategy for another host. Fresh-host evidence remains required before
expanding the supported platform matrix; local version output proves only the
current process environment.
