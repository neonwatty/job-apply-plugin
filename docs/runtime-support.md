# TypeScript runtime launch gate

Status: **unresolved**. The development runtime candidate is stable Node.js
22.0.0 or newer, with TypeScript compiled to JavaScript ES modules targeting
ES2022. This is a provisional compatibility floor, not a supported-platform
announcement. Do not rely on native TypeScript execution or newer Node APIs
without updating the floor and its tests through the integration owner.

No installed launcher or manifest changes in this phase. Python remains the
authoritative runtime and the only live Store writer. Retain necessary Swift
native helpers. TypeScript and Python differential writers use separate clones.

## Probe

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

## Evidence required before choosing a launch mode

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

### Pending platform acceptance

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
evidence. Installing dependencies or downloading a runtime during plugin launch
is prohibited.

Select one final strategy only after this matrix passes: a guaranteed Node
runtime or signed standalone executables. The current `launchMode` does not
make that decision. Fresh-host evidence, platform support and Python removal
remain open; local version output proves only the current process environment.
