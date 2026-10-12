# Opt-in dogfood package

Build from the exact reviewed commit on the intended machine. This creates a
local package, a native lock artifact for the current OS/architecture, and a
receipt. It does not install a plugin, open a Store, launch an agent, or change
the stable version. Uncommitted changes are excluded.

```sh
node tools/dogfood-package.mjs build --ref <reviewed-commit-sha> --output /absolute/new/dogfood-package
node tools/dogfood-package.mjs verify /absolute/new/dogfood-package
```

The output directory must not already exist. The native build uses the existing
native-lock packager and needs its supported local compiler/toolchain. A build
failure removes this newly created output. Rebuild separately for another
platform or architecture. The native packager rejects a commit whose native
source differs from the tool checkout's reviewed native source.

`plugin/` contains the same critical artifact inventory used by installed-package
checks, plus the committed lockfile, TypeScript configuration and source tree
needed for Companion’s first-launch bootstrap. It includes the Codex and Claude manifests, installed skills and their
references, checked-in runtime, Companion sources, and the native artifact.
The Claude marketplace is rewritten to resolve this local package. Manifest
versions stay unchanged; `receipt.json` identifies the full source commit and
records every packaged file's SHA256 plus an aggregate digest. Keep the receipt
with the package. Verification detects additions, removals, byte changes, and
symlinks against that receipt; it is an integrity check, not a signed attestation.

## Optional isolated install validation

Use fresh directories exclusively for this package. These commands use the
same host plugin registration routes as the release smoke harness. They do not
copy login credentials or start an agent. Run only the host you intend to test.

```sh
CODEX_HOME=/absolute/new/dogfood-codex-home codex plugin marketplace add /absolute/new/dogfood-package/plugin --json
CODEX_HOME=/absolute/new/dogfood-codex-home codex plugin add job-apply@neonwatty-plugins --json
CODEX_HOME=/absolute/new/dogfood-codex-home codex plugin list --json
```

```sh
CLAUDE_CONFIG_DIR=/absolute/new/dogfood-claude-config claude plugin marketplace add /absolute/new/dogfood-package/plugin
CLAUDE_CONFIG_DIR=/absolute/new/dogfood-claude-config claude plugin install job-apply@neonwatty-plugins
CLAUDE_CONFIG_DIR=/absolute/new/dogfood-claude-config claude plugin list --json
```

Retain the host's plugin-list output alongside the receipt. Verify that the
installed path is under the isolated home/config directory and corresponds to
this package. A successful CLI installation proves registration in that isolated
configuration. It does not prove discovery in an already running desktop app.

## Host-app activation and supervised pilot

Use `plugin/` from this same output as the local marketplace source in the
intended host's supported plugin installation flow. Select
`job-apply@neonwatty-plugins`. An app using a different configuration directory
will not see the isolated CLI registration above. Installing into the owner's
normal app configuration is a separate, explicit user action; this builder never
changes that configuration. If the app has no supported local marketplace route,
record host-app activation as blocked instead of substituting CLI agent runs.
A restart or a new chat may be necessary after installation.

Before a pilot, confirm in a fresh host-app chat that `$job-apply:job-apply` is
discoverable and resolves to this package's installed path. Compare the package
receipt's source commit with the intended review commit; the unchanged `1.3.5`
version alone does not establish provenance. Record that installed path and the
host's discovery result separately from the immutable build receipt. These steps
are a validation procedure; desktop discovery has not been established merely
by building or verifying a package.

For isolated Store checks, pass an explicit `--root /absolute/isolated-store` to
the installed `apps/companion/command.mjs` router. A real applicant Store and the
owner's existing browser/account require the pilot's explicit authorization.
Run the real pilot through the host app and existing browser session, follow the
installed skill, preserve drafts and consent boundaries, and stop at final
review. Final Submit/Send remains the applicant's action. CLI agent execution is
not a substitute for this host-app/browser validation.

The build receipt deliberately marks installed-host validation, host-app
discovery, and live application validation as `unrun`. Record observed results
as separate pilot evidence without upgrading these claims based on a unit test.


## Stop or roll back the experiment

Keep the previous plugin source and this package receipt. To stop an isolated
registration trial, close its processes and discard only its dedicated host
configuration and package directories. No applicant Store was used by these
registration commands.

For a package explicitly activated in the normal host app, finish or safely
hand off the active owner attempt first, then use the host's supported plugin
flow to restore the previous source and verify discovery in a fresh chat.
Changing plugin files does not undo Store transitions or application drafts.
This slice does not activate archive v2 or change the persisted schema; do not
use an older reader against a Store whose format it cannot read. Preserve the
review page and leave final submission to the owner throughout rollback.
