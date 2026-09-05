# Conditional runtime distribution recommendation

Date: 2026-09-05. Base: `8b85729e3f936fdbe124d6b3634c7ad421461215`.
Decision: **keep the launch gate unresolved**. Python remains authoritative.
The [acceptance matrix](acceptance-matrix.md) has zero accepted fresh-host cells.
Local Node 22.22.3 satisfies only the provisional development floor of stable
Node 22.0.0, ES2022 and compiled JavaScript ES modules.

## Official evidence and its limits

Sources were opened on the assessment date; these are documentation observations,
not measurements of a fresh installation.

- [OpenAI Codex CLI installation](https://developers.openai.com/codex/cli/)
  documents a standalone installer for macOS and Linux. That page did not
  establish a versioned Node runtime contract for third-party plugin children.
- [Claude Code setup](https://code.claude.com/docs/en/setup) states that the
  installed Claude binary does not invoke Node. Its current npm installation
  requirement is Node 22 or later as of v2.1.198, but the native binary does not
  use that Node at runtime. An npm installation prerequisite does not establish
  a native-host plugin runtime guarantee.
- [Claude desktop setup](https://code.claude.com/docs/en/desktop-quickstart)
  says users need not install Node separately. This does not promise a supported
  Node executable available to plugin child processes.

Inference: these sources do not justify assuming a guaranteed Node 22+ runtime
across the proposed native host matrix. This is not a claim that every host
lacks Node; no universal absence test was performed.

## Decision conditions

| Strategy | Evidence required before selection | Current assessment |
| --- | --- | --- |
| Guaranteed Node | Explicit versioned host contract exposing a supported executable to plugin children, lifecycle/update guarantees, exercised minimum version and every accepted host cell | Contract and fresh-host runs missing |
| Signed standalone per target | Reviewed self-contained artifacts, target/ABI inventory, verified signatures and integrity, native host invocation, upgrade/offline/rollback evidence for every accepted cell | No candidate artifacts or acceptance runs supplied |

Prefer evaluating signed standalone distribution if the host owners cannot
provide the Node contract. It avoids relying on an incidental developer runtime,
but it adds release engineering work and is not yet approved for launch.
If the contract is obtained and exercised across the entire declared matrix,
guaranteed Node remains a valid simpler candidate. Select one strategy only
after the evidence passes; do not add automatic download or package installation
as a fallback during launch.

For standalone evaluation, the integration owner must specify the packaging
technology and embedded engine version, supported OS/CPU/libc floors, licensing
inventory, signature trust roots and verification procedure. macOS acceptance
must include applicable signing/notarization and quarantine behavior; Windows
must include applicable signing and native process behavior; Linux must include
artifact signature verification and the declared libc targets. Verify tampered
artifact rejection and rollback to a previously verified package. These are
required evaluation criteria, not claims about existing artifacts. Preserve
the <=500-line policy for scoped source/tests/emitted modules; packaging is not
permission to replace the modular runtime with a monolithic generated file.

## Release gate and next owner action

The operator must execute the steps in the acceptance matrix on authorized clean
hosts. This task stops at that access boundary; it cannot manufacture fresh-host
provenance from a configured machine, a container, or a flag.

The integration owner should retain Task 1 steps 2 and 3 as open and link these
two documents from runtime support. No launcher, manifest, dependency, probe,
common schema or build change is requested by this package. Once a candidate
exists, schedule native acceptance separately from concurrent browser/package
suites and record immutable evidence before revisiting the launch decision.

Even a passing runtime matrix will not complete the migration: full behavioral
contracts, atomic writer cutover, privacy, permissions, upgrade/recovery and
Python-removal gates in the migration plan remain separate requirements.
