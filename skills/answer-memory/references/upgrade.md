# Python-era Store upgrade and recovery

Read before the first data operation after upgrading from the Python release,
or when explaining migration backup and recovery boundaries. Installed workflows
require Node.js 22 or newer on macOS arm64 or Linux x64; they never start Python.
A source-only Companion install additionally needs npm and registry access on
first launch. Keep actual Store paths and applicant values out of chat/logs.

## Upgrading an existing Python Store

1. Stop old plugin sessions, Companion servers, and application attempts before
   using the new version. Retained cached plugins must not write alongside the
   new runtime. The controller cannot discover and stop arbitrary older writers.
2. Keep a private backup of the complete Store, normally `~/.job-apply`, before
   upgrading. Keep applicant data out of the repository and diagnostic logs.
   Preserve the separate legacy profile/search-report files as well.
3. The first data command or Companion launch verifies the native lock and
   prepares/activates a private clone under the Store's locks. This can happen
   on a read request: `profile-get` is not an activation-free diagnostic.
   Help does not activate; `store paths` and `policy status` avoid creating an
   absent Store, but can activate an existing unactivated Store.
4. For the default root, activation retains the pre-switch directory at
   `~/.job-apply.python-rollback`. A custom root uses the same `.python-rollback`
   suffix. Supported existing documents keep their original bytes. The retained
   directory is a migration-time backup, not an ongoing mirror of later edits.
5. Review the profile, answer library, and application/session continuity in the
   new version. Existing applicant-wide facts are not guessed into a resume's
   scoped fact set; import/adopt a managed resume, request extraction, and review
   its facts before selecting it for an application run.
6. Once activated, use only the new native routes with that Store. An older
   Python package must never be pointed at the marked native Store.

The separate `~/.claude-job-profile.json` import remains non-destructive and
one-time; an existing canonical profile is authoritative. Legacy search reports
are not canonical jobs. Import only selected previewed entries with explicit
confirmation; startup can initialize/activate the Store before that preview.

## Recovery boundaries

Unsupported artifacts, unsafe permissions, unknown migration entries, corrupt
or future-version data, and ambiguous interruption states stop activation or
block data access. Do not delete ownership markers, edit journals, downgrade
schemas, change shared permissions, or blindly retry a write to bypass them.
The Store must remain private and owned; its canonical parent may allow
read/search access but cannot be group/other writable.

The installed package exposes no Python rollback command. If recovery needs an
older package, first stop all native writers and preserve both the current native
Store and migration backup. Restore a verified backup as a separate private
recovery copy and use the matching historical package only with that copy.
The migration backup does not include post-migration changes; retaining the
current native Store prevents losing those later records during investigation.
Do not mix writers or overwrite either retained directory to force a switch.
Use the current native router for normal operations; a historical package is
only for an explicitly isolated recovery copy. See the [storage contract](storage-contract.md).
