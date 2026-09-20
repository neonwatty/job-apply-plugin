## Resume records

Resume records use stable IDs and managed private copies. New imports accept PDF,
DOCX, and UTF-8 TXT files up to 10 MiB, reject duplicate content including trash,
and never persist the import source path. Legacy absolute-path records remain valid
until explicitly adopted under the same ID.

```bash
node "<plugin-root>/apps/companion/command.mjs" store resume-create --input <resume.json>
node "<plugin-root>/apps/companion/command.mjs" store resume-import --input <resume.json>
node "<plugin-root>/apps/companion/command.mjs" store resume-list
node "<plugin-root>/apps/companion/command.mjs" store resume-get --id <resume-id>
node "<plugin-root>/apps/companion/command.mjs" store resume-update \
  --id <resume-id> --expected-revision <revision> --input <patch.json>
node "<plugin-root>/apps/companion/command.mjs" store resume-adopt \
  --id <legacy-resume-id> --expected-revision <revision> [--path <source-path>]
node "<plugin-root>/apps/companion/command.mjs" store resume-set-default \
  --id <resume-id> --expected-revision <revision>
node "<plugin-root>/apps/companion/command.mjs" store resume-check --id <resume-id>
node "<plugin-root>/apps/companion/command.mjs" store resume-trash \
  --id <resume-id> --expected-revision <revision>
node "<plugin-root>/apps/companion/command.mjs" store resume-restore \
  --id <resume-id> --expected-revision <revision>
node "<plugin-root>/apps/companion/command.mjs" store resume-delete \
  --id <resume-id> --expected-revision <revision>
```

`resume-create` remains compatible and now performs the same managed import as the
preferred `resume-import`. A `path` patch replaces bytes atomically for a managed
record while preserving its ID and job assignments; legacy records require
`resume-adopt`. The first active resume becomes the default unless explicitly
declined. Trashing fails while a resume is explicitly assigned to an active job,
or while the default is implicitly selected by an active job with no assignment.
Restore selects the resume only when it is the sole active record. Permanent
deletion requires trash and no job reference, and releases the content digest.
`resume-check` reports availability without mutating the stored observation.

## Facts belonging to one resume

Companion requests extraction by default on import or replacement. After CLI import or replacement, the agent creates a scoped request with `resume-extraction-request-create --resume-id <id> --expected-resume-revision <revision> --scope resume` unless the owner opted out. The extraction agent completes only that request with `resume-extraction-request-complete-scoped --id <request-id> --expected-request-revision <revision> --input <private-candidate.json>`. This creates a draft in `resume-facts.json` and leaves `profile.json` unchanged.

Use `resume-facts-list` for value-free status. `resume-facts-get --resume-id <id>` returns the latest version and history privately for owner review. The owner may edit a draft in Companion and confirm it with `resume-facts-confirm --resume-id <id> --expected-fact-revision <revision> --expected-content-revision <content-revision>`. A replacement makes earlier facts stale; editing appends a new draft. Confirmed versions are immutable.

For each application, the agent obtains the owner's chat confirmation of the exact job, resume, and confirmed fact revision. Then `job-input-confirm --id <job-id> --resume-id <resume-id> --expected-revision <job-revision> --expected-resume-revision <resume-revision> --expected-fact-revision <fact-revision> --owner-confirmed` binds that selection before task selection or browser work. The application uses only that resume's confirmed facts. Reusable application answers stay in the separate answer library.

## Legacy resume extraction proposals

Extraction is performed by the calling agent and supplied as a bounded structured
JSON object; the helper does not parse, author, or tailor resumes. Inspect the
managed resume and profile revisions immediately before creating a proposal:

```bash
node "<plugin-root>/apps/companion/command.mjs" store resume-proposal-create \
  --resume-id <resume-id> --expected-resume-revision <resume-revision> \
  --expected-profile-revision <profile-revision> --input <candidate.json>
node "<plugin-root>/apps/companion/command.mjs" store resume-proposal-list \
  [--resume-id <resume-id>] [--status pending] [--summary-only]
node "<plugin-root>/apps/companion/command.mjs" store resume-proposal-get --id <proposal-id>
node "<plugin-root>/apps/companion/command.mjs" store resume-proposal-review \
  --id <proposal-id> --expected-revision <proposal-revision> \
  --expected-profile-revision <profile-revision> --input <decisions.json>
```

Creation auto-fills only absent or null unprotected facts with `source=resume`.
Blank strings, existing arrays or objects, and human-cleared/protected facts remain
pending. Review input has the form
`{"decisions":{"/json/pointer":"use_extracted|keep_current"}}`; accepted values
are stamped `source=user`. A review may decide only some pending paths. Never retry
a revision or selected-baseline conflict against unseen state. Creating another
pending proposal for the same resume requires `--supersedes <proposal-id>` so the
old record remains auditable. Resume replacement, trash, deletion, missing bytes,
or digest drift makes a proposal stale.

The default proposal list remains value-bearing for explicit local inspection.
Agents must use `--summary-only` for discovery and supersession; that projection
contains only opaque identities, revisions, states, and path counts.
