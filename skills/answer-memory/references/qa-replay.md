### Approved local QA routing

An approved replay URL has the exact loopback form `http://127.0.0.1:<port>/#qa-route=<run-id>.<64-lowercase-hex-token>`. Before **any** storage command for that workflow, resolve the complete fragment value without navigating it or printing it:

```bash
python3 "<plugin-root>/scripts/qa-replay.py" resolve --route-token "<qa-route-token>"
```

The resolver returns one JSON field, `storeRoot`. For the entire replay, add `--root "<resolved-storeRoot>"` immediately after `job-apply-store.py` on **every** command, including `init`, `profile-get`, answer, history, and session commands. Never omit `--root`, use `JOB_APPLY_STORE_DIR`, inspect the default store, or fall back to `~/.job-apply/` during an approved local replay. If resolution fails, stop the replay without making any storage call. Treat the route token and resolved path as private run metadata and do not repeat them in prose or logs.

For replay lifecycle evidence, use `qa-replay.py started --run-id "<run-id>"` before form work and `qa-replay.py reviewed --run-id "<run-id>"` only at visible final review. These idempotent commands use the same isolated store helper and persist only the run identifier, platform label, statuses, timestamps, and empty answer-key/pending-field lists. Never manufacture replay history or session files. `reviewed` requires the correlated server review event, an ordered start, a matching nonterminal run, and zero final-action activations.

After evaluation, or when abandoning a prepared replay, retire its synthetic data with `python3 "<plugin-root>/scripts/qa-replay.py" cleanup --run-id "<run-id>"`. Cleanup authenticates shutdown of a prepared fixture server and never signals an unknown process. For race safety it never unlinks run artifacts: it turns them into zero-length sanitized tombstones through verified open descriptors. Completed runs retain their redacted report and lifecycle tombstone; abandoned runs retain only a meaningful lifecycle tombstone, with all synthetic content and routing secrets sanitized. Running cleanup again is safe.

All examples elsewhere in these skills must use the explicit resolved `--root` while a QA route is active.

Do not directly create, parse, patch, append to, or replace files under `~/.job-apply/`. Do not recreate question normalization, answer keys, migration logic, permissions, or atomic writes in the agent. Use only helper commands described here and in [the storage contract](storage-contract.md).

Successful data commands return JSON on stdout. If the helper returns nonzero, stop the storage operation, preserve the existing files, and explain the failure without printing stored values.
