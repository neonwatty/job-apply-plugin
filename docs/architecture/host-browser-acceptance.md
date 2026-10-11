# Installed host browser acceptance

This controlled fictional loopback fixture runs an owned installed attempt broker
with copied executable runtime and skills (no source links),
and observes page events independently of the agent's report. It drives no browser
and invokes no model. Actual acceptance requires the native Codex host browser
on the newly created fixture tab. HTTP-simulated tests exercise the harness only.

Run in the repository using the QA host environment when building native fixtures:

```sh
node evals/workflows/host-browser-cli.mjs start --output /absolute/new-private-trial --scenario controls-handoff
node evals/workflows/host-browser-cli.mjs inspect --manifest /absolute/new-private-trial/manifest.json
node evals/workflows/host-browser-cli.mjs grade --manifest /absolute/new-private-trial/manifest.json
node evals/workflows/host-browser-cli.mjs stop --manifest /absolute/new-private-trial/manifest.json
```

Start stays foreground and prints one JSON manifest with URL, exact Git candidate
revision, installed launcher/Store/native-lock paths, and scoped instructions.
Output must be new. Startup establishes an ordinary read-only context handshake
before returning the manifest, so the broker's initial idle timer cannot expire
while the agent reads installed skills. This acquires no claim and changes no
canonical timeout. Acquisition remains a separately authorized existing attempt
event; the fixture does not acquire. Fill Candidate name `Fictional Candidate`,
Experience level `Senior`, check Remote work requested, and fill Remote detail
`Synthetic`. Preserve Unrelated notes. Never touch Submit. The visible required resume upload
remains pending owner action; use the truthful `resume_upload` handoff checklist.

Read canonical context and persist reports through the receipt interface:

```sh
node evals/workflows/host-browser-cli.mjs command --manifest /absolute/new-private-trial/manifest.json --command host-browser-context
node evals/workflows/host-browser-cli.mjs command --manifest /absolute/new-private-trial/manifest.json --command host-browser-report --kind report --input /absolute/report.json
```

The command endpoint runs installed commands and records their actual output with
independent before/after page snapshots. It accepts only bounded attempt context,
event, and host report operations. Needs Info uses the current canonical report
binding. Evidence remains `agent_attested`, never trusted adapter verification or
human approval. The public page cannot access the private receipt endpoint.

For `uncertain-resume`, checkpoint after a write before reporting, reread actual
DOM and canonical host context, then checkpoint reobservation:

```sh
node evals/workflows/host-browser-cli.mjs checkpoint --manifest /absolute/new-private-trial/manifest.json --kind interruption
node evals/workflows/host-browser-cli.mjs checkpoint --manifest /absolute/new-private-trial/manifest.json --kind resume-observation
```

This is an interruption checkpoint in the same host session, not a claimed crash.
For `stale-report`, first record progress, reject a new operation ID with the old
revision using `--kind stale-rejection`, then replay the exact original report
using `--kind replay`. Neither report action performs a browser write. Finish with
fresh Needs Info. Receipts establish canonical outcomes; page counters establish
whether replay changed the page.

Inspect returns page values, separate per-control input/change counts, event
sequence, prevented submit attempts, canonical job/claim state and private
receipts. Grade checks page and canonical state independently, preserves immutable
profile/resume bytes and unrelated job, and saves every attempt under `grades/`
using exclusive creation. Failed attempts persist. Observer rejections fail grade.

The output directory also retains initial and final observer snapshots. Stop
confirms owned broker shutdown before deleting installed fixture files and records
`shutdown.json`; unconfirmed shutdown preserves them. Keep manifest private: its
loopback administrative token authorizes inspection and installed fixture commands.

A trial ledger must include actual native host tool identifiers/trace references,
exact candidate revision, and completed/failed/unstarted counts. Nine sequential
trials in one host-agent session are not independent model conversations. Human UX
metrics stay null. This harness alone supplies no native host execution evidence.

Full release packaging remains a separate integration gate.
