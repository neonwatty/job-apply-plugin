# Host browser source input drift

The `source-input-drift` scenario uses an isolated fictional Store, copied
installed runtime, and controlled loopback form. It exercises input invalidation
without changing production policy or touching an owner Store or live ATS.

Acquire through the existing explicitly authorized attempt event. Fill the four
fictional controls using native host tools, preserve notes, and obtain
`host-browser-context` through the fixture `/command` endpoint. Retain its
progress action input before injecting drift.

Authenticated `POST /inject` accepts exactly:

```json
{"kind":"source-input-drift"}
```

The fixture reads its selected `source` resume and latest confirmed fact revision,
then calls the installed `store resume-facts-draft` command with those exact
revisions and fixed fictional facts. No source ID, path, revision, or replacement
content comes from the request. The operation appends one draft version to
`resume-facts.json`. Earlier versions, including every confirmed version, remain
intact; `resumes.json`, managed resume bytes, profile, jobs, and all other durable
files remain unchanged except a concurrent broker heartbeat may advance the paired
heartbeat and expiry timestamps with the existing 300-second lease duration. No
claim identity, bearer hash, job, or other coordinator field may change. A second injection requires a confirmed source and cannot
silently append another draft to this scenario.

The injection receipt records the supported command, exact revisions, returned
summary, complete before/after fact documents, per-file durable digests, and
before/after canonical and page snapshots. The grader permits exactly the intended
fact-file delta and requires all original fact versions as an unchanged prefix.
The narrow heartbeat exception verifies exact captured coordinator bytes against
the recorded digest before applying the paired timestamp check.
Unrelated fact sets must also remain unchanged.

Read fresh `host-browser-context` through `/command`. Its selection must report
`inputsCurrent: false`, omit progress, and offer the existing Needs Info handoff.
Observe the current DOM and record:

```json
{
  "kind": "drift-observation",
  "driftSequence": 3,
  "evidence": {
    "source": "native_host_browser",
    "url": "http://127.0.0.1:PORT/",
    "title": "Fictional host browser acceptance",
    "values": {
      "name": "Fictional Candidate",
      "level": "senior",
      "remote": true,
      "detail": "Synthetic",
      "notes": "Preserve this fictional unrelated note."
    }
  }
}
```

Use the actual injection sequence, URL, and observed values. Missing fresh context,
a stale sequence, or mismatching values rejects the checkpoint. New fixture HTTP
reports are blocked until observation; exact replay of an already accepted report
remains inert and grants no browser authority.

Convert the retained pre-drift progress action to a host report by removing `kind`
and adding a fresh `operationId`, `evidenceKind: agent_attested`, and
`outcome: progress`. Its rejection must preserve canonical state and the page.
The grader matches the complete payload against that earlier valid descriptor;
rejection of an arbitrary malformed payload provides no evidence of input checks.
Then convert the fresh handoff descriptor into a Needs Info host report, removing
`kind` and `status` and adding a fresh ID, evidence kind, and `outcome: needs_info`.
This guarded safe exit must release the claim without submitting the form or
repeating any browser write. The deliberately appended draft remains present.

This scenario ends at safe handoff. Confirmation of new facts, fresh preparation,
and a separately authorized new attempt remain subject to existing policy; this
scenario supplies no approval for restarting or silently rebinding the old task.

The focused test sends synthetic observer events and exercises real installed
commands. It proves fixture protocol and preservation behavior, not native browser
interaction. Actual acceptance additionally requires retained native host tool
transcripts. DOM observation remains `agent_attested`; HTTP observation gates do
not constrain direct installed CLI invocations or arbitrary host tools. Final
submission remains human-only, and no human UX or cross-host support claim follows
from a passing grade.
