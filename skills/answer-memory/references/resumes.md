## Resume records

Resume records use stable IDs and managed private copies. New imports accept PDF,
DOCX, and UTF-8 TXT files up to 10 MiB, reject duplicate content including trash,
and never persist the import source path. Legacy absolute-path records remain valid
until explicitly adopted under the same ID.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" resume-create --input <resume.json>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-import --input <resume.json>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-list
python3 "<plugin-root>/scripts/job-apply-store.py" resume-get --id <resume-id>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-update \
  --id <resume-id> --expected-revision <revision> --input <patch.json>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-adopt \
  --id <legacy-resume-id> --expected-revision <revision> [--path <source-path>]
python3 "<plugin-root>/scripts/job-apply-store.py" resume-set-default \
  --id <resume-id> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-check --id <resume-id>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-trash \
  --id <resume-id> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-restore \
  --id <resume-id> --expected-revision <revision>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-delete \
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

## Resume extraction proposals

Extraction is performed by the calling agent and supplied as a bounded structured
JSON object; the helper does not parse, author, or tailor resumes. Inspect the
managed resume and profile revisions immediately before creating a proposal:

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" resume-proposal-create \
  --resume-id <resume-id> --expected-resume-revision <resume-revision> \
  --expected-profile-revision <profile-revision> --input <candidate.json>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-proposal-list \
  [--resume-id <resume-id>] [--status pending] [--summary-only]
python3 "<plugin-root>/scripts/job-apply-store.py" resume-proposal-get --id <proposal-id>
python3 "<plugin-root>/scripts/job-apply-store.py" resume-proposal-review \
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
