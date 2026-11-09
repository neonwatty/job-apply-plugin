# T002 Worker Oracle Evidence

The isolated temporary-store walkthrough completed successfully.

- Human URL-only preview token: `job-upsert-v1.09d0a4c28f073231e7cdda9b5f70d0497e0618fb8adfdc107fbfa5cdc4924fb7`
- Human preview and commit: `create=1`, all other decision counts `0`
- Agent enrichment preview token: `job-upsert-v1.63fddd15d36e6ad7ba3eb2f5453df5b237b6503e3b2b1d40555e44061bdcac10`
- Agent preview and commit: `update=1`, all other decision counts `0`
- Incompatible agent replay: `conflict=1`, reason `incoming identity is incompatible with stored identity`
- Fresh replay token: `job-upsert-v1.950f5d1e338277f37ed30cfd930ce7bebc8c10db5aff3a3a2aab42d893c8a7e8`
- Fresh replay: `noop=1`; commit reported `committed=false`
- Stable job ID for both human and agent paths: `job-9c1411ab798b3f5a300afc7c`
- Final list count: `1`
- Final application status: `saved`
- Human-preserved role: `Principal Platform Engineer`
- Agent-added fields: company `Acme Systems`, location `Remote`, description `Build durable platforms.`
- `/url`, `/source`, `/sourceId`, and `/role` provenance: origin `human`, observation source `manual`
- `/company`, `/location`, and `/description` provenance: origin `agent`, observation source `manual`

Verification reported by the Worker:

- 5 focused ingestion tests passed.
- 42 job-store tests passed.
- 330 full repository tests passed.
- Plugin validation and isolated Claude Code/Codex installation smoke checks passed.

The Worker needed two verification attempts because the original module-qualified unittest command resolved an unrelated installed `tests` package. The PM replaced it with the repository-compatible `PYTHONPATH=tests` equivalent without changing coverage or allowed files.
