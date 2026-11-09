# Local Mac dogfood milestone

The user has prioritized completing and trying the TypeScript conversion on the
current Mac. This milestone qualifies only macOS 26.4.1 build 25E253 on arm64,
with Node 22.22.3 and Unicode 17.0. It does not represent a customer release or
clean-host installation promise.

The P02 collector resolves and hashes the actual Node, CPython aliases
`python3`, `python3.12`, `python3.13`, `python3.14`, and clang executables. It
records actual patch versions, filesystem encoding/error mode and OS build.
Aliases and direct executable probes must agree. Binary bytes and filesystem
identity are checked before and after probes, and alias resolution is checked
again before returning the identity. Later native cells compare fresh complete
identities before and after execution.

The collector uses fixed commands with bounded output and execution time. Missing
required aliases or tools on the matching host fail. A different host cannot
produce this milestone's acceptance: its required positive test skips, and the
strict evidence gate rejects that skipped result. Synthetic validator tests
never replace the actual-host witness.

P05 separately supplies required-cell and owned native fixture evidence. P02
alone does not accept native persistence, a native addon or browser interaction.
Python and TypeScript remain isolated from each other's live Store writes until
the later cutover gates authorize activation. Final application submission
remains manual.

The following qualifications remain open for later release work:

- Linux and Windows native qualification.
- Other Mac OS, CPU and runtime versions.
- Clean-host and offline customer installation.
- Browser and native account integrations.
- Physical durability and release deployment.

The frozen [P02 specification](evidence/p02/mac-dogfood-spec.json) defines exact
identity fields, tests and budgets. Recorded developer-installed tools are
observations about this host, not bundled customer runtime artifacts.
