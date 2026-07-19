# Local storage contract

The bundled helper is the sole supported mutation interface:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/job-apply-store.py" --help
```

## Files

- `~/.job-apply/profile.json`: versioned canonical profile and preferences.
- `~/.job-apply/answers.json`: versioned answer records with state, source, scope, aliases, sensitivity, and confirmation metadata.
- `~/.job-apply/applications.jsonl`: append-only minimal application events.
- `~/.job-apply/sessions/<application-id>.json`: resumable workflow metadata with answer-key references.

Directories use user-only permissions and canonical files use `0600` where the platform supports POSIX modes. JSON writes use a same-directory temporary file and atomic replacement.

## Migration

On first initialization, if the new profile does not exist and `~/.claude-job-profile.json` does, the helper copies the complete legacy object into `profile.json`. It preserves unknown keys and leaves the legacy file untouched. Once the new profile exists it is authoritative, so later changes to the legacy file are not re-imported.

## Versions and corruption

Current documents use `schemaVersion: 1`. A corrupt document, invalid shape, or future schema version causes the helper to fail non-destructively. Agents must not repair canonical files with text editing; preserve the file and explain the error.

## Answer identity

Known semantic fields may use documented keys. Dynamic questions receive `question.<sha256>` keys generated from versioned Unicode/whitespace/punctuation normalization plus canonical scope JSON. The helper also checks stored normalized aliases. Agents must call `answer-key` or `answer-find`, never implement this algorithm themselves.

Only a non-sensitive `confirmed` answer with matching scope may be reused without asking. `inferred`, `missing`, and every `sensitive` record require review. A stored sensitive value must carry the helper-generated consent timestamp, and the agent still reconfirms it before use.

## Data minimization

History and sessions reference answer keys instead of copying values. Their input schemas are closed: arbitrary nested applicant payloads are rejected. Credentials, browser state, CAPTCHA/MFA data, and payment information are never valid storage inputs.
