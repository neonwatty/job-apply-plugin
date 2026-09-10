# Optional Python companion

The HTML/JavaScript UI and Python HTTP server live in this directory. They are
excluded from the generated agent plugin (`scripts/build-plugin.py`). The plugin
retains a small discovery command; the CLI requires no companion installation.

## Install and launch

From a trusted source checkout, with Python 3.12:

```sh
python3 companion/install.py
python3 ~/.local/share/job-apply-companion/companion.py --root /absolute/path/to/store
```

On Windows use `py -3.12`, and the launcher path returned by the installer.
`--prefix /chosen/stable/path` chooses an installation location. Set
`JOB_APPLY_COMPANION_HOME` to that location when using the plugin's optional
`scripts/job-apply-workspace.py` discovery command. Never choose a host cache or
applicant Store directory as the installation prefix.

The installer copies a complete runtime, assets, canonical core and its contract
helpers into `versions/<version>-<content-digest>`. It uses Python's standard
library and adds no third-party runtime dependencies. It never opens the Store.
No installed code imports from the source checkout or plugin cache.

Launch is foreground and loopback-only. Ctrl-C stops it; run the same command to
restart. `--no-open` suppresses browser opening. The private URL appears only in
the attached terminal; do not paste its token into chat or diagnostics.

```sh
python3 ~/.local/share/job-apply-companion/companion.py --status --root /absolute/path/to/store
```

Status reports the selected **installation**, version, and Store path without
opening the Store or printing a token. It does not claim a server is running.
The default Store is `JOB_APPLY_STORE_DIR`, otherwise `~/.job-apply`.

## Core and compatibility

Both distributions carry the same source implementation of the public
`job-apply-store.py` facade: `Store`, `StoreError`, and the existing command/JSON
contracts. All writes use its locking, expected revisions and recovery. The UI
never writes JSON records directly or creates a second database.

| Companion contract | Core API | Store schema | Behavior |
| --- | --- | --- | --- |
| 1.3.5 | 1 | 1 | Supported Python release pair |
| Later companion with contract 1 | 1 | 1 | Same core semantics; upgrade regression exercises both clients |
| Other contract/schema | unsupported | unsupported | Launcher refuses before importing core or opening Store |

The bundle receipt pins every runtime file by SHA-256. The stable launcher checks
contract versions and file integrity before loading the core. Existing canonical
Store validation retains read-only recovery behavior for corrupt or future Store
data, blocking ordinary writes. This does not establish compatibility with the
TypeScript migration; do not share its live Store with the Python clients.

## Upgrade and rollback

Run `companion/install.py` from the chosen newer source checkout using the same
prefix. The installer finishes and verifies a new immutable bundle before
atomically selecting it. A running process keeps its version until stopped;
restart explicitly to adopt the new selection. Old bundles remain available.
Plugin upgrade/removal cannot change this installation.

To select an older compatible build, rerun its installer with the same prefix.
There is no automatic Store downgrade or schema rollback. Stop if the chosen
build cannot support the Store; retain a backup and use a compatible version.
Installation does not silently restart processes or migrate applicant data.

## Development and validation

In a source checkout only, `python3 companion/scripts/job-apply-workspace.py`
loads the adjacent repository core. Production launch uses the stable installed
entry point above. Tests exercise separate packaging, CLI writes visible in the
UI, deletion of the disposable source/plugin, upgrade while running, restart,
and incompatible/damaged bundles failing before Store creation.
