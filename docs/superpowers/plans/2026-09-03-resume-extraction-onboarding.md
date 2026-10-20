# Resume Extraction Requests and Profile Preparedness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the Companion resume library to the existing agent-driven extraction proposal workflow through a durable request queue, and give both the UX and CLI one value-free profile-preparedness projection.

**Architecture:** Extend the canonical Store with a separate value-free extraction-request document and include it in the existing crash-safe extraction transaction when resume, profile, and proposal state must change together. Reuse the existing opaque resume `contentRevision`, proposal auto-fill/review behavior, authenticated Companion server, and local-only agent workflow; the browser may request or cancel work but only the CLI agent may provide extracted candidate values.

**Tech Stack:** Python 3 standard library Store/HTTP server and `unittest`; vanilla JavaScript/HTML/CSS Companion; Node test runner and Playwright; Markdown skill contracts and shell packaging smoke checks.

**Spec:** `docs/superpowers/specs/2026-09-03-resume-extraction-onboarding-design.md`

## Global Constraints

- Extraction starts only after an explicit human or agent request; resume import never starts extraction.
- The existing Job Apply agent performs extraction. Do not embed a model in the Store or Companion and do not launch or wake a Codex task.
- The Store remains the sole mutation authority for requests, proposals, profiles, and preparedness.
- Request documents, public projections, logs, receipts, and handoff text contain no resume bytes, paths, filenames, content digests, fact values, raw model output, or raw errors.
- The Companion may list, create, cancel, and retry requests, but cannot complete/fail requests or submit candidate values.
- Missing/null unprotected facts retain the existing safe auto-fill behavior; conflicts and human-protected facts require review.
- Preparedness has essential setup, common coverage, and review health only. It has no percentage, quality score, employability signal, or claim of job readiness.
- There is no durable `processing` status and no automatic timeout for a `requested` item.
- No browser application flow, account flow, application final action, cloud sync, telemetry, OCR, or private owner data is used in implementation or acceptance.
- Add no runtime dependency and preserve Python, Linux, macOS, Windows, and packaged-plugin compatibility.

## File and Ownership Map

- `scripts/job-apply-store.py`: request schema, persistence, lifecycle, extraction transaction, preparedness projection, CLI commands.
- `tests/test_job_apply_store.py`: Store unit, concurrency, recovery, staleness, and projection tests.
- `tests/test_answer_memory_integration.py`: subprocess CLI contract and value-free output tests.
- `scripts/job-apply-workspace.py`: redacted request projections and authenticated browser routes.
- `tests/test_job_apply_workspace.py`: Companion API authorization, method, payload, redaction, and error mapping tests.
- `workspace/index.html`: readiness panel, extraction request controls, grouped review structure, confirmation dialog copy.
- `workspace/app.js`: request state, rendering, mutations, grouped proposal decisions, navigation, and conflict handling.
- `workspace/styles.css`: request-state, readiness, and grouped-review presentation with existing theme tokens.
- `tests_js/workspace.test.mjs`: pure UI contract tests and supervised real-browser workflow.
- `skills/job-workspace/SKILL.md`: truthful browser capabilities and request-handoff guidance.
- `skills/job-apply/SKILL.md`: request discovery, private extraction, completion/failure, and cleanup workflow.
- `scripts/smoke-plugin.sh`: packaged skill/command contract assertions.
- `README.md`: concise human workflow and privacy boundary.

---

### Task 1: Durable Request Document and Read/Create CLI

**Files:**
- Modify: `scripts/job-apply-store.py:142-160,1743-1995,1998-2200,10100-10370,10420-10670`
- Test: `tests/test_job_apply_store.py:4960-5425`
- Test: `tests/test_answer_memory_integration.py:680-770`

**Interfaces:**
- Consumes: existing `Store._new_resume_content_revision()`, `_managed_resume_observation()`, `exclusive_file_lock()`, `atomic_write_json()`, and managed resume records.
- Produces: `Store.create_resume_extraction_request(resume_id: str, expected_resume_revision: int) -> dict[str, Any]`, `get_resume_extraction_request(request_id: str) -> dict[str, Any] | None`, and `list_resume_extraction_requests(resume_id: str | None = None, status: str | None = None) -> list[dict[str, Any]]`.
- Produces CLI: `resume-extraction-request-create`, `resume-extraction-request-get`, and `resume-extraction-request-list`.

- [ ] **Step 1: Write failing Store tests for the closed schema and single-open invariant**

Add tests that create a managed resume, create one request, inspect its exact keys, and reject a second open request:

```python
request = self.store.create_resume_extraction_request(
    resume["id"], resume["revision"]
)
self.assertEqual(
    set(request),
    {
        "requestId", "resumeId", "resumeContentRevision", "revision",
        "status", "createdAt", "updatedAt", "closedAt", "proposalId",
        "failureReason", "supersedesRequestId",
    },
)
self.assertEqual(request["resumeContentRevision"], resume["contentRevision"])
self.assertEqual(request["status"], "requested")
with self.assertRaisesRegex(STORE_MODULE.StoreError, "open extraction request"):
    self.store.create_resume_extraction_request(resume["id"], resume["revision"])
```

Also prove unmanaged/trashed/missing resumes, stale record revisions, unsupported status filters, extra record fields, invalid IDs, and multiple persisted open requests fail closed.

- [ ] **Step 2: Run the focused Store tests and confirm the missing API failure**

Run:

```bash
python3 -m unittest -v tests.test_job_apply_store.JobApplyStoreTest.test_resume_extraction_request_create_and_single_open
```

Expected: `ERROR` with `AttributeError: 'Store' object has no attribute 'create_resume_extraction_request'`.

- [ ] **Step 3: Implement the request document, validation, initialization, and query methods**

Add closed constants and a validator:

```python
EXTRACTION_REQUEST_STATUSES = {
    "requested", "completed", "failed", "stale", "cancelled"
}
EXTRACTION_REQUEST_FAILURE_REASONS = {
    "content_unreadable", "unsupported_resume", "extraction_failed",
    "candidate_invalid", "interrupted",
}

def _validate_extraction_request(key: str, value: Any) -> dict[str, Any]:
    record = _require_object(value, "resume extraction request")
    required = {
        "requestId", "resumeId", "resumeContentRevision", "revision",
        "status", "createdAt", "updatedAt", "closedAt", "proposalId",
        "failureReason", "supersedesRequestId",
    }
    if set(record) != required or record.get("requestId") != key:
        raise StoreError("resume extraction request is invalid")
    _safe_session_id(key)
    _safe_session_id(record.get("resumeId", ""))
    try:
        TRUSTED_FILL_MODULE.validate_content_revision(
            record.get("resumeContentRevision")
        )
    except TRUSTED_FILL_MODULE.TrustedFillError as error:
        raise StoreError(str(error)) from None
    revision = record.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("resume extraction request revision is invalid")
    if record.get("status") not in EXTRACTION_REQUEST_STATUSES:
        raise StoreError("resume extraction request status is invalid")
    for field in ("createdAt", "updatedAt"):
        if not isinstance(record.get(field), str) or not record[field]:
            raise StoreError("resume extraction request timestamp is invalid")
    terminal = record["status"] != "requested"
    if terminal != (isinstance(record.get("closedAt"), str) and bool(record["closedAt"])):
        raise StoreError("resume extraction request closure is invalid")
    proposal_id = record.get("proposalId")
    if record["status"] == "completed":
        _safe_session_id(proposal_id or "")
    elif proposal_id is not None:
        raise StoreError("resume extraction request proposal is invalid")
    failure = record.get("failureReason")
    if record["status"] == "failed":
        if failure not in EXTRACTION_REQUEST_FAILURE_REASONS:
            raise StoreError("resume extraction failure reason is invalid")
    elif failure is not None:
        raise StoreError("resume extraction failure reason is invalid")
    supersedes = record.get("supersedesRequestId")
    if supersedes is not None:
        _safe_session_id(supersedes)
        if supersedes == key:
            raise StoreError("resume extraction supersession is invalid")
    return record
```

Add `self.resume_extraction_requests_path = self.root / "resume-extraction-requests.json"`, expose it from `paths()`, validate an existing file during read-only startup, and lazily create this private document only when request operations need it:

```python
now = utc_now()
document = {
    "schemaVersion": SCHEMA_VERSION,
    "requests": {},
    "metadata": {"createdAt": now, "updatedAt": now},
}
```

Under the store lock, request creation must verify a managed, active, byte-ready resume and exact resume record revision. If an older managed record lacks `contentRevision`, privately re-observe its digest, assign `_new_resume_content_revision()`, increment its general revision, and return the final request bound to the new token. Do not return the digest or filename.

- [ ] **Step 4: Add exact CLI parsers and dispatch**

Add:

```python
request_create = commands.add_parser("resume-extraction-request-create")
request_create.add_argument("--resume-id", required=True)
request_create.add_argument("--expected-resume-revision", required=True, type=int)
request_get = commands.add_parser("resume-extraction-request-get")
request_get.add_argument("--id", required=True)
request_list = commands.add_parser("resume-extraction-request-list")
request_list.add_argument("--resume-id")
request_list.add_argument("--status", choices=sorted(EXTRACTION_REQUEST_STATUSES))
```

Dispatch directly to the three Store methods and preserve the existing JSON stdout/error conventions.

- [ ] **Step 5: Add subprocess tests proving CLI parity and value-free output**

Create a request through the CLI, list and get it, and recursively assert that serialized output omits the private resume filename, managed path, digest, resume text, and seeded profile values:

```python
serialized = json.dumps(requests, sort_keys=True)
for forbidden in (source.name, str(source), resume["digest"], "private resume text"):
    self.assertNotIn(forbidden, serialized)
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
python3 -m unittest -v \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_extraction_request_create_and_single_open \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_extraction_request_document_rejects_invalid_records \
  tests.test_answer_memory_integration.AnswerMemoryIntegrationTest.test_resume_extraction_request_cli_is_value_free
git add scripts/job-apply-store.py tests/test_job_apply_store.py tests/test_answer_memory_integration.py
git commit -m "feat: add resume extraction request queue"
```

Expected: all named tests pass and the commit contains no workspace/UI changes.

---

### Task 2: Cancellation, Failure, Retry, and Resume-Lifecycle Staleness

**Files:**
- Modify: `scripts/job-apply-store.py:2600-2710,6985-7295,10100-10670`
- Test: `tests/test_job_apply_store.py:5200-5425`
- Test: `tests/test_answer_memory_integration.py:700-790`

**Interfaces:**
- Consumes: Task 1 request validator and read/create/query methods.
- Produces: `cancel_resume_extraction_request(request_id: str, expected_revision: int) -> dict[str, Any]`, `fail_resume_extraction_request(request_id: str, reason: str, expected_revision: int) -> dict[str, Any]`, and `retry_resume_extraction_request(request_id: str, expected_revision: int, expected_resume_revision: int) -> dict[str, Any]`.
- Produces: resume-content mutation and trash/delete operations that atomically close actionable requests.

- [ ] **Step 1: Write failing lifecycle and race tests**

Cover exact-revision cancellation, closed reason validation, retry supersession, cancellation-vs-late-writer conflict, and idempotence rejection:

```python
cancelled = self.store.cancel_resume_extraction_request(
    request["requestId"], request["revision"]
)
self.assertEqual(cancelled["status"], "cancelled")
self.assertEqual(cancelled["revision"], request["revision"] + 1)
with self.assertRaisesRegex(STORE_MODULE.StoreError, "request revision conflict"):
    self.store.fail_resume_extraction_request(
        request["requestId"], "interrupted", request["revision"]
    )
```

Replace the managed resume and assert its formerly open request becomes `stale`; edit only its label/tags and assert the request stays `requested`. Trash must cancel an open request in the same committed state; permanent delete must leave no actionable request reference.

- [ ] **Step 2: Run focused tests and confirm lifecycle methods are missing**

Run:

```bash
python3 -m unittest -v tests.test_job_apply_store.JobApplyStoreTest.test_resume_extraction_request_lifecycle_and_revision_conflicts
```

Expected: failure on the first missing lifecycle method.

- [ ] **Step 3: Extend the extraction journal to commit requests and optional resumes atomically**

Replace the two-document journal payload with a backward-compatible closed operation that may carry all four documents:

```python
operation = {
    "kind": kind,
    "operationId": f"extraction-{uuid.uuid4()}",
    "profileDocument": profile_document,
    "proposalsDocument": proposals_document,
    "requestsDocument": requests_document,
    "resumesDocument": resumes_document,
}
```

The loader must accept legacy `create`/`review` operations with only profile and proposals, and new request operations with the exact expanded keys. Roll-forward writes only documents present in the validated operation, in deterministic order, then clears the journal. Injected-crash tests must prove every boundary repairs to the complete old or complete new state.

- [ ] **Step 4: Implement lifecycle methods and integrate content mutation/trash/delete**

Use one closed transition helper:

```python
def _close_resume_extraction_request_locked(
    self, requests_document: dict[str, Any], request_id: str,
    expected_revision: int, status: str, failure_reason: str | None = None,
) -> dict[str, Any]:
    current = requests_document["requests"].get(request_id)
    if current is None:
        raise StoreError("resume extraction request does not exist")
    if current["revision"] != expected_revision:
        raise StoreError("request revision conflict")
    if current["status"] != "requested":
        raise StoreError("resume extraction request is not open")
    now = utc_now()
    updated = {
        **current,
        "status": status,
        "failureReason": failure_reason,
        "revision": current["revision"] + 1,
        "updatedAt": now,
        "closedAt": now,
    }
    _validate_extraction_request(request_id, updated)
    requests_document["requests"][request_id] = updated
    requests_document["metadata"]["updatedAt"] = now
    return updated
```

Rules:

- only `requested` may transition;
- cancel stores no failure reason;
- fail accepts only the five closed reason codes;
- retry accepts only `failed` or `stale`, creates a new `requested` record, and records `supersedesRequestId`;
- managed byte replacement/adoption changes `contentRevision` and closes the open request as `stale`;
- label, tag, and default changes leave the request open;
- trash closes the open request as `cancelled` in the same journal operation;
- delete rejects any still-open request and keeps terminal audit records value-free.

- [ ] **Step 5: Add CLI routes and failure-output tests**

Add `resume-extraction-request-cancel --id --expected-revision`, `resume-extraction-request-fail --id --reason --expected-revision`, and `resume-extraction-request-retry --id --expected-revision --expected-resume-revision`. Confirm argparse closes the failure vocabulary and that error output cannot echo resume metadata or fact values.

- [ ] **Step 6: Run lifecycle, resume, and recovery tests and commit**

Run:

```bash
python3 -m unittest -v \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_extraction_request_lifecycle_and_revision_conflicts \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_request_stales_only_on_content_change \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_request_journal_recovers_every_boundary \
  tests.test_answer_memory_integration.AnswerMemoryIntegrationTest.test_resume_extraction_request_lifecycle_cli
git add scripts/job-apply-store.py tests/test_job_apply_store.py tests/test_answer_memory_integration.py
git commit -m "feat: make extraction request lifecycle crash safe"
```

Expected: tests pass with no partially updated request/resume pair after injected failures.

---

### Task 3: Atomic Request Completion into Existing Proposals

**Files:**
- Modify: `scripts/job-apply-store.py:1850-1985,2600-2710,7270-7555,10340-10660`
- Test: `tests/test_job_apply_store.py:4960-5425`
- Test: `tests/test_answer_memory_integration.py:700-810`

**Interfaces:**
- Consumes: Task 2 expanded extraction journal, existing `_validated_candidate()`, `_pointer_baseline()`, `_user_protects_path()`, and proposal review contract.
- Produces: `complete_resume_extraction_request(request_id: str, candidate_input: dict[str, Any], expected_request_revision: int, expected_profile_revision: int, expected_pending_proposal_id: str | None = None) -> dict[str, Any]` returning exact `request` and value-free `proposalSummary` keys.
- Preserves: legacy `create_resume_proposal` CLI behavior while new request-created proposals bind `resumeContentRevision`.

- [ ] **Step 1: Write failing completion, supersession, and no-partial-write tests**

Exercise missing fact auto-fill plus one protected conflict:

```python
result = self.store.complete_resume_extraction_request(
    request["requestId"],
    {"firstName": "Extracted", "email": "fixture@example.invalid"},
    request["revision"],
    profile["revision"],
)
self.assertEqual(result["request"]["status"], "completed")
self.assertEqual(
    result["request"]["proposalId"], result["proposalSummary"]["id"]
)
proposal = self.store.get_resume_proposal(result["proposalSummary"]["id"])
self.assertIn("/email", proposal["autoFilledPaths"])
self.assertIn("/firstName", proposal["pendingPaths"])
```

Also prove cancellation, stale content, changed profile revision, invalid candidate, wrong/no pending-proposal supersession ID, and two completions create neither a second proposal nor a partial profile update.

- [ ] **Step 2: Run the focused completion test and verify it fails on the missing method**

Run:

```bash
python3 -m unittest -v tests.test_job_apply_store.JobApplyStoreTest.test_resume_extraction_request_completion_is_atomic
```

Expected: missing-method failure.

- [ ] **Step 3: Extract one internal proposal-construction routine and implement completion**

Refactor without changing legacy results:

```python
def _create_resume_proposal_locked(
    self,
    resume: dict[str, Any],
    candidate_input: dict[str, Any],
    profile_document: dict[str, Any],
    proposals_document: dict[str, Any],
    supersedes: str | None,
    *,
    bind_content_revision: bool,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Return validated profile document, proposal document, and proposal."""
```

`complete_resume_extraction_request()` must validate request, resume content token and private observation, profile revision, and explicit pending proposal ID under the same lock. It calls this routine with `bind_content_revision=True`, updates the request, then commits profile/proposals/requests atomically. Its return object includes the completed request plus only proposal ID, status, revision, auto-filled count, and pending count; the candidate is not echoed.

Extend proposal validation so new records contain `resumeContentRevision` and omit neither the legacy private digest nor required compatibility fields unless a schema migration is deliberately added. `_proposal_stale_reasons()` uses the content token for new proposals and the existing revision/digest behavior for legacy records. Cosmetic resume metadata edits must not stale new proposals.

- [ ] **Step 4: Add the completion CLI while keeping candidate input off argv/stdout**

Add:

```python
request_complete = commands.add_parser("resume-extraction-request-complete")
request_complete.add_argument("--id", required=True)
request_complete.add_argument("--input", required=True)
request_complete.add_argument("--expected-request-revision", required=True, type=int)
request_complete.add_argument("--expected-profile-revision", required=True, type=int)
request_complete.add_argument("--expected-pending-proposal-id")
```

The candidate remains in a permission-restricted JSON file or stdin through `_read_input`; it is never accepted as a JSON argv string. Completion output is the value-free summary defined above. The existing explicitly invoked `resume-proposal-get` command retains its local value-bearing detail contract.

- [ ] **Step 5: Prove full crash recovery and legacy proposal compatibility**

For each journal write boundary, reopen a new `Store`, call `initialize()`, and assert exactly one completed request, one proposal, and the expected profile revision. Re-run existing proposal autofill/review/supersession tests unchanged. Add a legacy proposal fixture without `resumeContentRevision` and prove it still validates and stales under its old contract.

- [ ] **Step 6: Run focused and existing proposal suites and commit**

Run:

```bash
python3 -m unittest -v \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_extraction_request_completion_is_atomic \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_request_completion_conflicts_are_noops \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_request_completion_journal_recovers_every_boundary \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_proposal_autofill_review_and_stale_baselines \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_proposal_supersession_staleness_and_journal_recovery \
  tests.test_answer_memory_integration.AnswerMemoryIntegrationTest.test_resume_request_completion_cli
git add scripts/job-apply-store.py tests/test_job_apply_store.py tests/test_answer_memory_integration.py
git commit -m "feat: complete extraction requests into proposals"
```

Expected: new and legacy paths pass, with exactly-once request completion.

---

### Task 4: Shared Profile-Preparedness Projection

**Files:**
- Modify: `scripts/job-apply-store.py:3000-3130,7435-7560,10100-10670`
- Test: `tests/test_job_apply_store.py:5400-5560`
- Test: `tests/test_answer_memory_integration.py:780-850`

**Interfaces:**
- Consumes: profile inspection, active resume observation, extraction request summaries, and proposal summaries from Tasks 1–3.
- Produces: `Store.profile_preparedness() -> dict[str, Any]` and CLI `profile-preparedness-get`.

- [ ] **Step 1: Write a failing table-driven projection test**

Assert the exact top-level shape and meaningful-presence rules:

```python
projection = self.store.profile_preparedness()
self.assertEqual(set(projection), {"essentialSetup", "commonCoverage", "reviewHealth"})
self.assertEqual(
    [item["id"] for item in projection["essentialSetup"]],
    ["first_name", "last_name", "email", "default_resume"],
)
self.assertNotIn("score", json.dumps(projection).lower())
```

Test whitespace/null/empty objects/empty arrays as `not_present`; non-empty phone/location/work-history/education/skills/link groups as `present`; missing, unreadable, and changed default resumes as distinct reason codes; and requested/failed/stale/pending/human-protected review items as ID-only health links.

- [ ] **Step 2: Run the focused projection test and confirm the missing method**

Run:

```bash
python3 -m unittest -v tests.test_job_apply_store.JobApplyStoreTest.test_profile_preparedness_is_value_free_and_deterministic
```

Expected: missing-method failure.

- [ ] **Step 3: Implement deterministic meaningful-presence helpers and projection**

Use closed helpers, not client-specific booleans:

```python
def _meaningfully_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return True
```

Return stable items such as:

```json
{
  "id": "default_resume",
  "state": "blocked",
  "reasonCode": "default_resume_unreadable",
  "resumeId": "opaque-id"
}
```

Essential states are `present` or `blocked`; common coverage states are `present` or `not_present`. Review-health items use `kind`, `reasonCode`, `resumeId`/`requestId`/`proposalId`, and counts only. Never include profile values, paths to local files, labels, filenames, digests, or candidate values.

- [ ] **Step 4: Add the read-only CLI and privacy tests**

Register `profile-preparedness-get` with no mutation arguments. Seed unique private strings in every profile group and the resume file; recursively assert none appears in serialized projection output while IDs and reason codes remain usable.

- [ ] **Step 5: Run projection and CLI tests and commit**

Run:

```bash
python3 -m unittest -v \
  tests.test_job_apply_store.JobApplyStoreTest.test_profile_preparedness_is_value_free_and_deterministic \
  tests.test_job_apply_store.JobApplyStoreTest.test_profile_preparedness_reports_review_health \
  tests.test_answer_memory_integration.AnswerMemoryIntegrationTest.test_profile_preparedness_cli_matches_store
git add scripts/job-apply-store.py tests/test_job_apply_store.py tests/test_answer_memory_integration.py
git commit -m "feat: project shared profile preparedness"
```

Expected: identical Store/CLI projection and no score or private value.

---

### Task 5: Authenticated Companion Request and Preparedness API

**Files:**
- Modify: `scripts/job-apply-workspace.py:60-205,533-735,748-1288`
- Test: `tests/test_job_apply_workspace.py:1480-1620`

**Interfaces:**
- Consumes: Store interfaces from Tasks 1–4.
- Produces: `GET /api/resume-extraction-requests`, `POST /api/resume-extraction-requests`, `POST /api/resume-extraction-requests/{id}/cancel`, `POST /api/resume-extraction-requests/{id}/retry`, and `GET /api/profile-preparedness`.
- Produces: `public_extraction_request(record: dict[str, Any]) -> dict[str, Any]` and resume projections with only the latest request summary.

- [ ] **Step 1: Write failing API authorization and method-boundary tests**

Prove unauthenticated requests return 401, browser mutations require the existing anti-CSRF mutation authorization, wrong methods return 404/405 according to current router behavior, and payloads must have exact keys:

```python
status, body = self.request_json(
    "POST", "/api/resume-extraction-requests",
    {"resumeId": resume["id"], "expectedResumeRevision": resume["revision"]},
)
self.assertEqual(status, 200)
self.assertEqual(body["status"], "requested")
self.assertNotIn("resumeContentRevision", body)
```

Attempt `complete`, `fail`, `candidate`, `expectedProfileRevision`, and extra-body routes/fields and assert rejection without Store mutation.

- [ ] **Step 2: Run the focused API test and verify routes are absent**

Run:

```bash
python3 -m unittest -v tests.test_job_apply_workspace.WorkspaceApiTest.test_resume_extraction_request_api_is_redacted_and_bounded
```

Expected: 404 on the create route.

- [ ] **Step 3: Implement closed public projections and GET routes**

Use an allowlist:

```python
def public_extraction_request(record: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "requestId", "resumeId", "revision", "status", "createdAt",
        "updatedAt", "closedAt", "proposalId", "failureReason",
        "supersedesRequestId",
    }
    return {key: record.get(key) for key in allowed}
```

Do not expose `resumeContentRevision`. Add the request GET list and preparedness GET routes. Extend `resume_projection()` with a nested `extractionRequest` using only this public projection and select deterministically by latest timestamp then request ID.

- [ ] **Step 4: Implement exact create/cancel/retry mutations**

Accept only:

```json
{"resumeId": "opaque-id", "expectedResumeRevision": 1}
```

for create,

```json
{"expectedRevision": 1}
```

for cancel, and

```json
{"expectedRevision": 2, "expectedResumeRevision": 3}
```

for retry. Map revision conflicts to the existing 409 envelope and invalid lifecycle state to 400. Do not add browser routes for completion or failure.

- [ ] **Step 5: Add redaction and Store-parity assertions**

Seed a filename, digest, fact value, candidate, and raw failure-looking string; enumerate every new API response and assert none is present. Compare the API preparedness object byte-for-byte with `store.profile_preparedness()`.

- [ ] **Step 6: Run API and existing workspace suites and commit**

Run:

```bash
python3 -m unittest -v \
  tests.test_job_apply_workspace.WorkspaceApiTest.test_resume_extraction_request_api_is_redacted_and_bounded \
  tests.test_job_apply_workspace.WorkspaceApiTest.test_profile_preparedness_api_matches_store \
  tests.test_job_apply_workspace.WorkspaceApiTest.test_resume_proposal_review_api
git add scripts/job-apply-workspace.py tests/test_job_apply_workspace.py
git commit -m "feat: expose extraction requests to companion"
```

Expected: public APIs are authenticated, redacted, and cannot complete extraction.

---

### Task 6: Resumes Workspace Request and Handoff Experience

**Files:**
- Modify: `workspace/index.html:193-208,461-490`
- Modify: `workspace/app.js:370-375,1469-1585,2160-2290`
- Modify: `workspace/styles.css:39-55,145-150`
- Test: `tests_js/workspace.test.mjs:860-1035,1980-2150`

**Interfaces:**
- Consumes: Task 5 resume `extractionRequest` projection and create/cancel/retry endpoints.
- Produces: `extractionRequestView(request, proposalSummary) -> {label: string, action: string, tone: string}` pure helper; explicit request controls and value-free handoff copy.

- [ ] **Step 1: Write failing pure rendering tests for every request state**

Export and test one closed state mapper:

```javascript
assert.deepEqual(extractionRequestView(null, null), {
  label: "Facts not extracted",
  action: "request",
  tone: "neutral",
});
assert.equal(extractionRequestView({ status: "requested" }, null).action, "cancel");
assert.equal(extractionRequestView({ status: "failed" }, null).action, "retry");
assert.equal(extractionRequestView({ status: "stale" }, null).action, "fresh");
assert.equal(
  extractionRequestView({ status: "completed" }, { status: "pending" }).action,
  "review",
);
```

Also assert the `requested` label contains “Waiting for a Job Apply agent” and never “Extracting”.

- [ ] **Step 2: Run the Node unit tests and verify the helper is missing**

Run:

```bash
node --test --test-name-pattern='extraction request view' tests_js/workspace.test.mjs
```

Expected: import/export failure for `extractionRequestView`.

- [ ] **Step 3: Add accessible request controls and honest copy**

Add a request-state region in each resume card/dialog with `role="status"`, one primary action, and a secondary handoff-copy button only while requested. The primary labels are exactly:

- `Request fact extraction`
- `Cancel request`
- `Review changes`
- `View facts`
- `Try again`
- `Request fresh extraction`

On successful creation show: “Request saved. The next active Job Apply agent can extract facts from this resume.” The copied handoff is exactly:

```text
Use the Job Apply resume workflow to process extraction request <request-id>.
```

Do not include the resume label, original filename, candidate, or profile values.

- [ ] **Step 4: Implement mutations with stale-response and revision-conflict handling**

Add request data to `resumeState`, load it through the resume projection, bind buttons without inline handlers, and preserve selected metadata/file drafts during refresh. Create, cancel, and retry send exact Task 5 bodies. A 409 shows the existing refresh-first conflict surface and does not retry automatically.

- [ ] **Step 5: Add a real-browser workflow using a synthetic managed resume**

The Playwright test must import a fixture, request extraction, verify CLI sees the same request, verify the UI says waiting rather than extracting, copy the value-free handoff, cancel, retry after a seeded failure/stale state, and navigate to an existing pending proposal. It must assert that no request UI control can send a candidate or call a complete/fail route.

- [ ] **Step 6: Run UI unit/browser tests and commit**

Run:

```bash
node --test --test-name-pattern='extraction request|resume workspace' tests_js/workspace.test.mjs
npm run test:qa-browser
git add workspace/index.html workspace/app.js workspace/styles.css tests_js/workspace.test.mjs
git commit -m "feat: request resume extraction from companion"
```

Expected: all request states are keyboard accessible, honestly worded, and revision safe.

---

### Task 7: Profile Readiness and Grouped Proposal Review

**Files:**
- Modify: `workspace/index.html:130-192,474-480`
- Modify: `workspace/app.js:650-850,1520-1585,2220-2240`
- Modify: `workspace/styles.css:120-150`
- Test: `tests_js/workspace.test.mjs:880-1035,1820-1980,2090-2150`

**Interfaces:**
- Consumes: Task 5 `GET /api/profile-preparedness` and existing public proposal detail/review routes.
- Produces: `proposalGroupForPath(path: string) -> "Identity" | "Contact" | "Location" | "Experience" | "Education" | "Skills" | "Links"`, grouped review UI, `Keep all current`, and stale-proposal fresh-request navigation.

- [ ] **Step 1: Write failing grouping and readiness-rendering tests**

Define deterministic pointer grouping:

```javascript
assert.equal(proposalGroupForPath("/firstName"), "Identity");
assert.equal(proposalGroupForPath("/email"), "Contact");
assert.equal(proposalGroupForPath("/location/city"), "Location");
assert.equal(proposalGroupForPath("/workHistory"), "Experience");
assert.equal(proposalGroupForPath("/education"), "Education");
assert.equal(proposalGroupForPath("/skills"), "Skills");
assert.equal(proposalGroupForPath("/linkedInUrl"), "Links");
```

Unknown top-level facts remain in a final `Additional` group for forward compatibility; they must not disappear. Assert rendered preparedness contains no percentage, score, or “application ready” text.

- [ ] **Step 2: Run focused UI tests and confirm helpers/surfaces are absent**

Run:

```bash
node --test --test-name-pattern='profile readiness|proposal groups' tests_js/workspace.test.mjs
```

Expected: helper/surface assertions fail.

- [ ] **Step 3: Add the compact Profile readiness panel**

Load preparedness alongside profile data and render three sections:

- Essential setup: first name, last name, email, default resume;
- Common coverage: phone, location, work history, education, skills, links;
- Review health: request/proposal links and closed reason copy.

Use Store-provided states and reason codes without recalculation. Include the fixed reminder: “Individual jobs may still require additional information.” Never render an aggregate score or green/red employability state.

- [ ] **Step 4: Group proposal rows and add safe bulk behavior**

Render fieldsets under group headings in the fixed order from the design, followed by `Additional`. Show current provenance next to current value and extracted candidate. Keep each selector initially blank. Add **Keep all current** to set every still-pending selector to `keep_current`; do not add an accept-all-extracted control.

For `use_extracted` on structured replacements, retain the existing exact replacement checkbox and require a second confirmation dialog before POST. Partial decisions remain supported. A stale proposal disables submission, explains that the resume changed, and offers **Request fresh extraction**, which navigates to its resume request control.

- [ ] **Step 5: Add real-browser accessibility and behavior proof**

Seed a value-free preparedness projection and a proposal spanning every group. Verify heading order, keyboard focus, blank default decisions, safe keep-all behavior, one accepted/one retained fact, structured-array confirmation, partial review persistence, stale navigation, and CLI observation of the same resulting profile.

- [ ] **Step 6: Run UI and proposal Store regression tests and commit**

Run:

```bash
node --test --test-name-pattern='profile readiness|proposal group|resume proposal' tests_js/workspace.test.mjs
python3 -m unittest -v \
  tests.test_job_apply_workspace.WorkspaceApiTest.test_resume_proposal_review_api \
  tests.test_job_apply_store.JobApplyStoreTest.test_resume_proposal_autofill_review_and_stale_baselines
git add workspace/index.html workspace/app.js workspace/styles.css tests_js/workspace.test.mjs
git commit -m "feat: clarify profile readiness and extraction review"
```

Expected: grouped review remains partial/revision safe and preparedness remains advisory.

---

### Task 8: Agent Workflow, Documentation, and Packaged Contract

**Files:**
- Modify: `skills/job-apply/SKILL.md:145-175`
- Modify: `skills/job-workspace/SKILL.md:1-220`
- Modify: `README.md`
- Modify: `scripts/smoke-plugin.sh:880-950`
- Test: `tests/test_job_apply_skill_contract.py`
- Test: `tests_js/workspace.test.mjs:980-1035`

**Interfaces:**
- Consumes: all Task 1–7 commands and UI wording.
- Produces: one bounded request-fulfillment procedure that stops at proposal/review and one truthful workspace capability description.

- [ ] **Step 1: Write failing skill-contract tests**

Assert the Job Apply skill contains the exact discovery and completion commands, the five failure reasons, private temporary-file cleanup, explicit supersession, and a prohibition on scanning during every application. Assert the workspace skill says it can create/cancel/retry requests but cannot extract or complete them.

```python
self.assertIn("resume-extraction-request-list --status requested", job_apply)
self.assertIn("resume-extraction-request-complete", job_apply)
self.assertIn("delete the permission-restricted candidate file", job_apply)
self.assertNotIn("the workspace extracts", workspace_skill.lower())
```

- [ ] **Step 2: Run the skill tests and verify missing-contract failures**

Run:

```bash
python3 -m unittest -v tests.test_job_apply_skill_contract
```

Expected: new assertions fail against the old instructions.

- [ ] **Step 3: Document the exact agent request-fulfillment loop**

The Job Apply skill procedure must say:

1. Check `resume-extraction-request-list --status requested` only when asked about resumes, facts, or onboarding, or when given a request ID.
2. Get the exact request and resolve the exact managed resume privately.
3. Inspect the current profile revision and any pending proposal for explicit supersession.
4. Extract into an owner-readable temporary JSON candidate.
5. Complete once with exact request/profile revisions and optional pending proposal ID.
6. On a closed failure, record only one approved reason; on a revision conflict, discard and report without retry.
7. Delete the candidate file on success, failure, or interruption.
8. Stop at proposal/review; do not begin a job application or browser workflow.

The workspace skill and README explain that **Request fact extraction** queues work for the next active agent and does not start one.

- [ ] **Step 4: Extend packaged smoke assertions**

Check that the packaged Store parser exposes all request and preparedness commands, both skills contain the handoff boundary, and workspace assets reference only the four allowed request endpoints. Do not make the smoke test access a real Store, resume, browser profile, or network service.

- [ ] **Step 5: Run skill, smoke, and packaging tests and commit**

Run:

```bash
python3 -m unittest -v tests.test_job_apply_skill_contract
bash scripts/smoke-plugin.sh
node --test --test-name-pattern='skill and documentation contracts' tests_js/workspace.test.mjs
git add skills/job-apply/SKILL.md skills/job-workspace/SKILL.md README.md scripts/smoke-plugin.sh tests/test_job_apply_skill_contract.py tests_js/workspace.test.mjs
git commit -m "docs: connect agents to extraction requests"
```

Expected: packaged artifacts describe the same truthful Store/UX boundary.

---

### Task 9: Deterministic End-to-End Oracle and Final Regression

**Files:**
- Create: `qa/resume_extraction_onboarding_oracle.py`
- Modify: `package.json`
- Modify: `.github/workflows/validate.yml`
- Test: `tests/test_qa_contracts.py`
- Test: `tests_js/workspace.test.mjs`

**Interfaces:**
- Consumes: completed Store, CLI, Companion, UX, and skill contracts.
- Produces: `npm run qa:resume-extraction-onboarding`, a value-free JSON receipt, and CI coverage on Linux/Windows plus existing macOS validation.

- [ ] **Step 1: Write a failing oracle contract test**

Require the oracle to accept only repository-relative fixture and temporary Store paths, emit a final object with closed booleans, and reject owner-store/home paths:

```python
self.assertEqual(
    set(receipt),
    {
        "requestShared", "autofillObserved", "conflictsReviewed",
        "profileShared", "contentChangeStaled", "racesRejected",
        "privacyVerified", "agentStoppedAtReview", "passed",
    },
)
self.assertTrue(all(receipt.values()))
```

- [ ] **Step 2: Run the contract test and confirm the oracle is missing**

Run:

```bash
python3 -m unittest -v tests.test_qa_contracts.ResumeExtractionOnboardingOracleTest
```

Expected: failure because `qa/resume_extraction_onboarding_oracle.py` does not exist.

- [ ] **Step 3: Implement the deterministic redacted-fixture oracle**

Use the committed redacted resume fixture and a temporary Store to execute:

1. managed import;
2. explicit request creation;
3. CLI list parity;
4. deterministic candidate completion;
5. safe auto-fill plus grouped conflicts;
6. one keep-current and one use-extracted review;
7. CLI profile parity;
8. content replacement and staleness;
9. cancel/concurrent/profile-revision/crash-recovery checks;
10. serialization scans across request/preparedness CLI and API, log, receipt,
    and handoff outputs;
11. static skill proof that the agent stops at review.

Do not invoke a model, browser application, owner Store, owner resume, OS credential service, or final action. Print only the closed JSON receipt; temporary paths and fixture content must not appear.

- [ ] **Step 4: Wire the oracle into package scripts and CI**

Add:

```json
"qa:resume-extraction-onboarding": "python3 qa/resume_extraction_onboarding_oracle.py --json"
```

Run it in the existing cross-platform validation jobs rather than adding an unprotected optional workflow. Preserve all current CI jobs and security settings.

- [ ] **Step 5: Run the complete local verification matrix**

Run:

```bash
npm run qa:resume-extraction-onboarding
npm run test:qa-browser
python3 -m unittest discover -s tests -p 'test_*.py'
bash scripts/smoke-plugin.sh
git diff --check
```

Expected: oracle `passed: true`; 0 failures; only documented skips; no diff-check errors.

- [ ] **Step 6: Perform a fresh-agent acceptance and record only value-free evidence**

In a fresh local task using a temporary Store and the redacted fixture, give only the request ID and ask the agent to follow the Job Apply resume workflow. Verify it discovers the request, completes a proposal, deletes its temporary candidate, and stops before any application/browser action. Record command names, opaque IDs, status codes, and pass/fail only—never candidate values or fixture text.

- [ ] **Step 7: Commit the oracle and CI gate**

Run:

```bash
git add qa/resume_extraction_onboarding_oracle.py package.json .github/workflows/validate.yml tests/test_qa_contracts.py tests_js/workspace.test.mjs
git commit -m "test: gate resume extraction onboarding"
```

Expected: the final commit adds the reproducible completion oracle without changing version, release, or final-action policy.

---

## Final Review Checklist

- [ ] Map every requirement in the design spec to Tasks 1–9 and identify no uncovered requirement.
- [ ] Confirm request list/get/API/activity/handoff outputs are value-free and path-free.
- [ ] Confirm there is no durable `processing` state, timeout, embedded model, automatic task launch, or import-triggered extraction.
- [ ] Confirm browser routes cannot complete/fail requests or submit candidate/profile revision data.
- [ ] Confirm metadata edits do not stale requests or new proposals, while content changes do.
- [ ] Confirm one of two concurrent completions wins and the loser produces no partial write.
- [ ] Confirm profile preparedness is Store-owned, identical in CLI/UX, and contains no score or job-readiness claim.
- [ ] Confirm grouped review defaults to no decision, supports partial review, provides only safe keep-all, and confirms structured replacements.
- [ ] Confirm the redacted fixture—not owner data—drives the complete oracle.
- [ ] Confirm full Python, Node/browser, packaging, Linux, macOS, and Windows gates are green before opening or merging any implementation PR.
