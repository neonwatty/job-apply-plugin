## Profile and preferences

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" profile-get
python3 "<plugin-root>/scripts/job-apply-store.py" profile-inspect
python3 "<plugin-root>/scripts/job-apply-store.py" profile-replace \
  --input <profile.json> --expected-revision <revision> \
  --source <user|resume|agent|migration>
python3 "<plugin-root>/scripts/job-apply-store.py" profile-patch \
  --input <patch.json> --expected-revision <revision> \
  --source <user|resume|agent|migration>
python3 "<plugin-root>/scripts/job-apply-store.py" preferences-get
python3 "<plugin-root>/scripts/job-apply-store.py" preferences-set \
  --input <preferences.json> --expected-revision <revision> \
  --source <user|resume|agent|migration> [--replace]
```

Inspect the profile immediately before either mutation and pass its current revision.
`preferences-set` merges supplied keys and preserves all other profile and preference
fields. Use `--replace` only after the user explicitly chooses to replace the full
preferences object. A revision conflict means the profile changed concurrently;
reload it and resolve the difference instead of retrying the stale write.

`profile-get` keeps the legacy raw-profile response. Use `profile-inspect` before a
selective edit to obtain the current revision and fact provenance, then pass that
revision to `profile-patch`. A conflict means another client changed the profile;
reload and show the user the current data instead of retrying a stale patch.

## Fact groups

Fact groups are durable saved views over canonical profile JSON-pointer paths. They
organize the Facts workspace for both people and agents without moving, copying, or
owning applicant facts. Removing a group never removes a profile value. Labels are
unique case-insensitively; create, update, and delete use the versioned
`fact-groups.json` document, and existing-group writes require the exact revision.

```bash
python3 "<plugin-root>/scripts/job-apply-store.py" fact-group-list
python3 "<plugin-root>/scripts/job-apply-store.py" fact-group-get --id <group-id>
python3 "<plugin-root>/scripts/job-apply-store.py" fact-group-create --input <group.json>
python3 "<plugin-root>/scripts/job-apply-store.py" fact-group-update \
  --id <group-id> --expected-revision <revision> --input <patch.json>
python3 "<plugin-root>/scripts/job-apply-store.py" fact-group-delete \
  --id <group-id> --expected-revision <revision>
```

Create input contains `label`, one or more unique JSON-pointer `paths`, and an
optional integer `order`. Update can selectively change `label`, `paths`, or
`order`. A revision conflict means another client changed the saved view; reload
the group and review the latest membership instead of retrying. Never treat group
membership as authorization to fill, transmit, overwrite, or delete a fact.
