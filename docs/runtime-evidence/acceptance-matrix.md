# Runtime acceptance evidence

Assessment date: 2026-09-05. Result: **unresolved; no accepted host cells**.
Repository base: `8b85729e3f936fdbe124d6b3634c7ad421461215`.
Evidence was collected in an isolated worktree on `codex/ts-runtime-acceptance`.
This ledger supplements [runtime support](../runtime-support.md); it does not
declare platform support or activate a launcher.

## Available environment and provenance

Only the existing local development machine was inspected. No clean host or
operator-attested fresh installation was available to this task. No remote
machine was used; a configured connection would not establish freshness.
No software was installed and no host configuration or live Store was changed.

| Observation | Exact value | Provenance and limitation |
| --- | --- | --- |
| Local OS / architecture | macOS 26.4.1 / arm64 | Python platform APIs in the existing Codex task shell |
| Python | 3.14.4 | `platform.python_version()`; diagnostic bootstrap only |
| Node | 22.22.3 | Existing inherited PATH; provider and installation history unverified |
| Codex desktop | 26.803.41515, build 6321 | Application bundle version metadata; existing installation |
| Codex CLI | 0.147.0-alpha.6.5 | `codex --version`; not a stable-release acceptance run |
| Claude Code CLI | 2.1.220 | `claude --version`; installation method and history unverified |
| Plugin evidence source | Base commit above | Repository diagnostic, not an installed candidate package |

Version commands were bounded to ten seconds and only recognized version text
was retained. Version presence does not establish host-native installation
provenance. No Claude session, fresh plugin installation, or actual candidate
launcher was exercised. Private paths, environment values and identity are
intentionally absent.

## Diagnostic results

Commands ran from the existing task's development shell, with the harness's
own child-environment filtering. The surrounding shell was not certified clean.

| Command | Result | What it establishes |
| --- | --- | --- |
| `python3 qa/runtime_launch_evidence.py --environment inherited-path` | Node 22.22.3, `candidate` | Local version observation only |
| `python3 qa/runtime_launch_evidence.py --environment node-free-simulation` | Node absent, `unavailable` | Synthetic missing-Node behavior only |
| `node tools/probe-installed-runtime.mjs` | Node 22.22.3, `node-candidate` | Existing Node can bootstrap the JS probe |

Both Python receipts have `schemaVersion: 1`, `platform: "darwin"`,
`arch: "arm64"`, `hostClaim: "none"`,
`provenance: "unverified-self-report"`, `freshHostVerified: false`, and
`launchMode: "unresolved"`. The inherited receipt has `nodeAvailable: true`;
the simulated receipt has `nodeAvailable: false` and `nodeVersion: null`.
Their `environment` fields match the command arguments. All three exited zero;
that means receipt emission, not acceptance. No `--host-claim` flag can certify
freshness. A missing Python interpreter would block this harness, not prove
that Node is missing.

## Proposed coverage, not supported-platform declarations

Each host column requires its own fresh native installation and actual plugin
invocation. Exact supported host product, stable version, OS minimum and CPU
availability must be resolved before accepting each cell. Desktop and CLI
results are not interchangeable. WSL, containers and translated execution do
not satisfy a native Windows or native CPU cell.

| Proposed OS / architecture | Codex | Claude Code | Available task evidence |
| --- | --- | --- | --- |
| macOS / arm64 | Unresolved | Unresolved | Existing development host only |
| macOS / x64 | Unresolved | Unresolved | No authorized clean environment |
| Linux glibc / x64 | Unresolved | Unresolved | No authorized clean environment |
| Linux glibc / arm64 | Unresolved | Unresolved | No authorized clean environment |
| Windows native / x64 | Unresolved | Unresolved | No authorized clean environment |
| Windows native / arm64 | Unresolved | Unresolved | No authorized clean environment |

Linux distribution, libc floor and kernel floor remain unspecified. If musl is
proposed, add separate x64 and arm64 cells; glibc results cannot cover them.
Probe recognition of `ia32` or `arm` is not a proposal to support those targets.
If a host product does not support a proposed target, explicitly exclude that
product/target combination rather than recording a passing substitute.

## Operator procedure to resolve each cell

These are pending operator steps, not operations performed by this task.

1. Obtain explicit authority for a disposable clean native OS environment and
   host installation. Record a non-identifying evidence ID, date, exact OS/build,
   CPU, image provenance and clean-baseline attestation. Use separate baselines
   for Codex and Claude. Do not borrow developer profiles, PATH or bundled
   workspace dependency runtimes.
2. Install a pinned supported host through its official native distribution.
   Record host product/version, installer source, digest/signature verification,
   installation method and any prerequisites installed separately. Record Node
   presence before and after host installation using the OS's native command
   discovery, without dumping paths. Do not silently install Node or Python.
3. Stage the reviewed diagnostic source at the base above and a separately
   approved candidate plugin package. Record package version, immutable source
   SHA, digest and installed inventory. This task has no TS launcher candidate;
   stop the launch portion until the integration owner supplies one.
4. Start the host through its normal native entry point. Through its ordinary
   command tool, follow [the diagnostic guide](SKILL.md) with an already
   available Python interpreter, using the appropriate `--host-claim` and both
   environments. Do not source profiles or use a login shell to supply Node.
   If Python is absent, record a harness bootstrap blocker and stop this step.
   Preserve closed receipts plus independent operator provenance; never rewrite
   `freshHostVerified` or treat a self-report as an attestation.
5. Invoke the candidate via the installed plugin's documented entry point,
   using only disposable synthetic data. Record module resolution, version
   handling, child process start/exit/cancellation, permissions, and exact
   expected/actual outcomes. Repeat with genuinely missing and unsupported Node
   on authorized disposable baselines; the simulation alone is insufficient.
6. Exercise fresh install, upgrade from a pinned previous package, cold offline
   runtime launch, and rollback. Record both package digests, Store fixture
   digests/modes before and after, recovery result and installed module inventory.
   No dependency installation or runtime download may occur at plugin launch.
   Distinguish local runtime offline behavior from the host's model connectivity.
7. Have an independent reviewer associate each passing result with its evidence
   ID and exact host/package/OS cell. Unrun, unavailable, unsupported and failed
   cases remain distinct. Publish only the redacted ledger and approved receipts.

## Verification of this bounded documentation package

- `node --test tests_js/runtime-support.test.mjs`: 5 tests passed.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_runtime_launch_evidence`:
  11 tests passed.
- `npm run check:size`: passed.
- Both new Markdown files were checked explicitly for <=500 physical lines.
- Runtime build was not run: this isolated worktree has no local TypeScript
  compiler dependency. No source or emitted runtime changed; no dependency was
  installed to broaden this documentation task.

Synthetic tests cover receipt behavior, not fresh host launches, OS support,
signing, installed inventory, upgrade, offline operation or rollback. The
[contract corpus](../contract-corpus.md) also leaves most command behavior
unfrozen; runtime acceptance cannot authorize Python removal by itself.
