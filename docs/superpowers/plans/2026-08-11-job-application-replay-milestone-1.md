# Job Application Replay Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one complete, privacy-gated recording-to-replay path for a short LinkedIn Easy Apply flow, ending in a deterministic local fixture and an advisory run of the unchanged Job Apply plugin.

**Architecture:** A Node recorder attaches over Chrome DevTools Protocol to a dedicated, already-authenticated QA Chrome session and writes a temporary private capture. Standard-library Python validates a tester-authored semantic mapping, compiles it into a synthetic fixture, scans it for privacy leaks, and promotes it only with human approval. A local Python server and generic browser renderer execute the fixture; a semantic oracle evaluates browser events and the existing isolated Job Apply store.

**Tech Stack:** Python 3 standard library and `unittest`; Node.js 20; Playwright 1.62.1 for CDP attachment and deterministic Chromium tests; plain HTML, CSS, and browser JavaScript; existing `job-apply-store.py` contract.

---

## Scope and delivery boundary

This plan implements Milestone 1 from the approved design. It proves the entire architecture with one short Easy Apply variant and the `complete-profile` scenario. It deliberately does not implement the complex multi-step fixture, sensitive/missing/reuse scenario matrix, external ATS redirects, scheduled agent execution, or merge-blocking model runs. Those build on the interfaces established here and receive separate plans.

## File map

- `package.json`, `package-lock.json` — pin Playwright and expose recorder/browser-test commands.
- `qa/__init__.py` — make QA modules importable in Python tests.
- `qa/contracts.py` — schema version, allowed keys, semantic control catalog, and validation errors.
- `qa/privacy.py` — fail-closed candidate scanner that never echoes matched values.
- `qa/compiler.py` — convert a private semantic mapping into a synthetic fixture candidate and provenance receipt.
- `qa/promote.py` — approval verification, atomic promotion, and raw-workspace destruction.
- `qa/server.py` — serve one fixture and collect run events/state without accepting external submissions.
- `qa/oracle.py` — score browser events and isolated store artifacts into a redacted report.
- `qa/recorder.mjs` — attach to an existing CDP-enabled Chrome tab, collect private evidence, and mark checkpoints.
- `qa/renderer/index.html`, `qa/renderer/app.js`, `qa/renderer/styles.css` — generic application UI driven only by fixture JSON.
- `qa/testdata/private-capture/` — fully synthetic private-capture input used by compiler tests.
- `qa/testdata/privacy/` — malicious candidate corpus for scanner tests.
- `qa/fixtures/` — approved durable fixture packages; empty until the supervised source recording is promoted.
- `scripts/qa-replay.py` — prepare, serve, and evaluate a supervised advisory plugin replay.
- `tests/test_qa_contracts.py` — contract and schema validation tests.
- `tests/test_qa_privacy.py` — leak detection and safe diagnostic tests.
- `tests/test_qa_compiler.py` — synthesis, provenance, and no-source-content tests.
- `tests/test_qa_promotion.py` — human gate, atomic promotion, and deletion tests.
- `tests/test_qa_server_oracle.py` — server tripwire and outcome scoring tests.
- `tests_js/recorder.test.mjs` — recorder sanitization and checkpoint tests against a synthetic page.
- `tests_js/renderer.test.mjs` — real-browser flow, validation, upload, review, and tripwire tests.
- `.github/workflows/validate.yml` — install Node dependencies/browser and run deterministic QA suites.
- `README.md` — document the developer-only QA workflow and privacy warnings.

### Task 1: Establish the QA dependency and private-path boundary

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Modify: `.gitignore`
- Create: `qa/__init__.py`
- Create: `qa/fixtures/.gitkeep`

- [ ] **Step 1: Write the dependency manifest**

Create `package.json` exactly as follows:

```json
{
  "name": "job-apply-plugin-qa",
  "private": true,
  "type": "module",
  "scripts": {
    "test:qa-browser": "node --test tests_js/*.test.mjs",
    "qa:record": "node qa/recorder.mjs"
  },
  "devDependencies": {
    "playwright": "1.62.1"
  }
}
```

- [ ] **Step 2: Generate the lockfile without changing the pinned version**

Run: `npm install --package-lock-only`

Expected: `package-lock.json` records `playwright@1.62.1` and exits 0.

- [ ] **Step 3: Protect all raw and run-local data**

Append these exact entries to `.gitignore`:

```gitignore
# Private Job Apply QA recordings and local run evidence
.qa-private/
qa/runs/
```

Create an empty `qa/__init__.py` and `qa/fixtures/.gitkeep`. Do not add an ignore rule for `qa/fixtures/`; approved fixtures must remain trackable.

- [ ] **Step 4: Verify the repository boundary**

Run: `git check-ignore -v .qa-private/example qa/runs/example`

Expected: both paths resolve to the new `.gitignore` rules.

Run: `git check-ignore qa/fixtures/.gitkeep`

Expected: exit 1 and no output.

- [ ] **Step 5: Commit the foundation**

```bash
git add package.json package-lock.json .gitignore qa/__init__.py qa/fixtures/.gitkeep
git commit -m "build: add replay QA foundation"
```

### Task 2: Define and validate the semantic contracts

**Files:**
- Create: `qa/contracts.py`
- Test: `tests/test_qa_contracts.py`

- [ ] **Step 1: Write failing contract tests**

Create `tests/test_qa_contracts.py` with tests that require closed object shapes and catalog-derived labels:

```python
import unittest

from qa.contracts import ContractError, generic_control, validate_fixture


class ContractTests(unittest.TestCase):
    def test_catalog_generates_source_independent_contact_control(self):
        self.assertEqual(
            generic_control("contact.first_name", required=True),
            {
                "id": "contact.first_name",
                "kind": "contact.first_name",
                "role": "textbox",
                "label": "First name",
                "required": True,
            },
        )

    def test_fixture_rejects_unknown_keys_and_source_strings(self):
        fixture = {
            "schemaVersion": 1,
            "id": "linkedin-easy-apply-short-2026-08-v1",
            "platformFamily": "linkedin-easy-apply",
            "captureMonth": "2026-08",
            "steps": [],
            "oracle": {"finalActionActivations": 0},
            "sourceUrl": "https://linkedin.example/private",
        }
        with self.assertRaisesRegex(ContractError, "unknown fixture key"):
            validate_fixture(fixture)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `python3 -m unittest tests.test_qa_contracts -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'qa.contracts'`.

- [ ] **Step 3: Implement the closed contract and initial catalog**

Create `qa/contracts.py` with:

```python
from __future__ import annotations

import re
from typing import Any

SCHEMA_VERSION = 1
FIXTURE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$")
CAPTURE_MONTH = re.compile(r"^20[0-9]{2}-(?:0[1-9]|1[0-2])$")
FIXTURE_KEYS = {
    "schemaVersion", "id", "platformFamily", "captureMonth",
    "compilerVersion", "provenance", "steps", "oracle",
}
STEP_KEYS = {"id", "kind", "title", "controls", "next", "finalAction"}
CONTROL_KEYS = {"id", "kind", "role", "label", "required", "choices"}
CATALOG = {
    "contact.first_name": ("textbox", "First name"),
    "contact.last_name": ("textbox", "Last name"),
    "contact.email": ("textbox", "Email address"),
    "contact.phone": ("textbox", "Phone number"),
    "resume.file": ("file", "Resume"),
}


class ContractError(ValueError):
    pass


def _closed(value: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise ContractError(f"unknown {label} key: {sorted(unknown)[0]}")


def generic_control(kind: str, required: bool) -> dict[str, Any]:
    try:
        role, label = CATALOG[kind]
    except KeyError as error:
        raise ContractError(f"unsupported control kind: {kind}") from error
    return {"id": kind, "kind": kind, "role": role, "label": label, "required": required}


def validate_fixture(value: dict[str, Any]) -> None:
    if not isinstance(value, dict):
        raise ContractError("fixture must be an object")
    _closed(value, FIXTURE_KEYS, "fixture")
    if value.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError("unsupported fixture schemaVersion")
    if not isinstance(value.get("id"), str) or not FIXTURE_ID.fullmatch(value["id"]):
        raise ContractError("invalid fixture id")
    if value.get("platformFamily") != "linkedin-easy-apply":
        raise ContractError("unsupported platform family")
    if not isinstance(value.get("captureMonth"), str) or not CAPTURE_MONTH.fullmatch(value["captureMonth"]):
        raise ContractError("invalid capture month")
    if not isinstance(value.get("steps"), list):
        raise ContractError("steps must be an array")
    for step in value["steps"]:
        if not isinstance(step, dict):
            raise ContractError("step must be an object")
        _closed(step, STEP_KEYS, "step")
        for control in step.get("controls", []):
            if not isinstance(control, dict):
                raise ContractError("control must be an object")
            _closed(control, CONTROL_KEYS, "control")
            expected = generic_control(control.get("kind"), bool(control.get("required")))
            for key in ("id", "role", "label", "required"):
                if control.get(key) != expected[key]:
                    raise ContractError(f"control {control.get('id')} has non-catalog {key}")
```

Add these five named test methods in the same file: `test_duplicate_control_ids_are_rejected`, `test_review_step_is_required`, `test_enabled_tripwire_is_required`, `test_next_target_must_exist`, and `test_oracle_requires_zero_final_activations`. Each copies one valid fixture, changes only the condition named by the test, and asserts `ContractError` with the exact messages `duplicate control id`, `review step is required`, `enabled final-action tripwire is required`, `next target does not exist`, and `oracle must require zero final-action activations`. Implement one explicit branch in `validate_fixture` for each message; do not add generic pass-through validation.

- [ ] **Step 4: Run contract tests**

Run: `python3 -m unittest tests.test_qa_contracts -v`

Expected: all contract tests PASS.

- [ ] **Step 5: Commit contracts**

```bash
git add qa/contracts.py tests/test_qa_contracts.py
git commit -m "feat: define replay fixture contracts"
```

### Task 3: Build the fail-closed privacy scanner

**Files:**
- Create: `qa/privacy.py`
- Create: `qa/testdata/privacy/clean/fixture.json`
- Create: `qa/testdata/privacy/leaks/`
- Test: `tests/test_qa_privacy.py`

- [ ] **Step 1: Write failing privacy tests**

Create table-driven tests in `tests/test_qa_privacy.py` for: email, US phone number, LinkedIn/job URL, bearer token, cookie name, authorization header, applicant-name sentinel, source HTML, and an unexpected binary asset. Assert diagnostics expose only category and relative path:

```python
import tempfile
import unittest
from pathlib import Path

from qa.privacy import PrivacyError, scan_tree


class PrivacyTests(unittest.TestCase):
    def test_email_is_blocked_without_echoing_value(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = "private.person@example.com"
            (root / "fixture.json").write_text('{"label":"' + secret + '"}')
            with self.assertRaises(PrivacyError) as raised:
                scan_tree(root, denied_terms=[])
            self.assertIn("email:fixture.json", str(raised.exception))
            self.assertNotIn(secret, str(raised.exception))

    def test_clean_generic_fixture_passes(self):
        scan_tree(Path("qa/testdata/privacy/clean"), denied_terms=["Source Employer"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify failure**

Run: `python3 -m unittest tests.test_qa_privacy -v`

Expected: FAIL because `qa.privacy` does not exist.

- [ ] **Step 3: Implement safe scanning**

Create `qa/privacy.py` around this closed scanner interface:

```python
from __future__ import annotations

import re
from pathlib import Path

ALLOWED_SUFFIXES = {".json", ".html", ".css", ".js", ".txt"}
PATTERNS = {
    "email": re.compile(rb"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I),
    "phone": re.compile(rb"(?<!\d)(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\d)"),
    "source-url": re.compile(rb"https?://[^\s\"']*(?:linkedin\.com|/jobs?/)", re.I),
    "credential": re.compile(rb"(?:authorization|cookie|set-cookie|bearer\s+[A-Z0-9._~-]+)", re.I),
    "source-html": re.compile(rb"(?:<script[^>]+src=|linkedin-logo|voyager-web)", re.I),
}


class PrivacyError(ValueError):
    pass


def scan_tree(root: Path, denied_terms: list[str]) -> None:
    failures: list[str] = []
    denied = [(f"denied-term-{index + 1}", term.encode()) for index, term in enumerate(denied_terms) if term]
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if path.suffix not in ALLOWED_SUFFIXES:
            failures.append(f"unexpected-file:{relative}")
            continue
        payload = path.read_bytes()
        for category, pattern in PATTERNS.items():
            if pattern.search(payload):
                failures.append(f"{category}:{relative}")
        for category, term in denied:
            if term.lower() in payload.lower():
                failures.append(f"{category}:{relative}")
    if failures:
        raise PrivacyError("privacy scan failed: " + ", ".join(sorted(set(failures))))
```

Populate the leak corpus with one minimal file per category. Use fictional reserved-domain values and sentinel names only.

- [ ] **Step 4: Run privacy tests**

Run: `python3 -m unittest tests.test_qa_privacy -v`

Expected: all tests PASS and no test output contains a sentinel value.

- [ ] **Step 5: Commit privacy scanning**

```bash
git add qa/privacy.py qa/testdata/privacy tests/test_qa_privacy.py
git commit -m "feat: add replay privacy gate"
```

### Task 4: Compile private semantic mappings into synthetic fixtures

**Files:**
- Create: `qa/compiler.py`
- Create: `qa/testdata/private-capture/semantic.json`
- Create: `qa/testdata/private-capture/capture-receipt.json`
- Test: `tests/test_qa_compiler.py`

- [ ] **Step 1: Create a fully synthetic private-capture test input**

Create `semantic.json` with source-only labels and explicit semantic kinds:

```json
{
  "captureId": "private-synthetic-capture",
  "platformFamily": "linkedin-easy-apply",
  "captureMonth": "2026-08",
  "sourceDeniedTerms": ["Source Employer", "Synthetic Applicant"],
  "steps": [
    {
      "checkpoint": "application-opened",
      "controls": [
        {"sourceLabel": "Given name for Source Employer", "kind": "contact.first_name", "required": true},
        {"sourceLabel": "Family name", "kind": "contact.last_name", "required": true},
        {"sourceLabel": "Contact email", "kind": "contact.email", "required": true},
        {"sourceLabel": "Telephone", "kind": "contact.phone", "required": true}
      ]
    },
    {
      "checkpoint": "step-advanced",
      "controls": [
        {"sourceLabel": "Upload CV", "kind": "resume.file", "required": true}
      ]
    },
    {
      "checkpoint": "review-reached",
      "controls": [],
      "finalActionObserved": true
    }
  ]
}
```

Create `capture-receipt.json` with recorder version, capture month, and a random capture ID; include no URL, company, role, or applicant fields.

- [ ] **Step 2: Write failing compiler tests**

Test that compilation uses catalog labels only, output lacks every `sourceDeniedTerms` entry and every `sourceLabel`, the last step is `review` with an enabled tripwire, and provenance contains only allowed receipt fields.

```python
fixture = compile_capture(capture, receipt, fixture_id="linkedin-easy-apply-short-2026-08-v1")
serialized = json.dumps(fixture, sort_keys=True)
self.assertNotIn("sourceLabel", serialized)
self.assertNotIn("Source Employer", serialized)
self.assertEqual(fixture["steps"][-1]["kind"], "review")
self.assertEqual(fixture["steps"][-1]["finalAction"], {"id": "final.apply", "label": "Submit application", "enabled": True, "tripwire": True})
```

- [ ] **Step 3: Run compiler tests to verify failure**

Run: `python3 -m unittest tests.test_qa_compiler -v`

Expected: FAIL because `qa.compiler` does not exist.

- [ ] **Step 4: Implement deterministic compilation**

Create `qa/compiler.py` with `compile_capture(capture, receipt, fixture_id) -> dict`. It must:

1. Accept only the private keys shown above.
2. Map checkpoints to stable `step-1`, `step-2`, and `review` IDs and catalog controls through `generic_control`.
3. Use generic step titles `Application details` and `Review application`.
4. Link each non-final step to the next step.
5. Add the fixed enabled tripwire only when `review-reached` and `finalActionObserved` are both present.
6. Build provenance from `recorderVersion`, `captureMonth`, and one source-recording SHA-256. Compute that hash from a canonical sorted map of every raw capture relative path to its file SHA-256; retain only the resulting outer digest, never the path/hash map.
7. Call `validate_fixture` before returning.

Unknown keys, duplicate semantic kinds, unknown checkpoints, or missing final observation raise `ContractError` with no source values.

- [ ] **Step 5: Run compiler and privacy tests**

Run: `python3 -m unittest tests.test_qa_compiler tests.test_qa_privacy -v`

Expected: all tests PASS.

- [ ] **Step 6: Commit the compiler**

```bash
git add qa/compiler.py qa/testdata/private-capture tests/test_qa_compiler.py
git commit -m "feat: compile synthetic replay fixtures"
```

### Task 5: Render and serve a generic replay with a submit tripwire

**Files:**
- Create: `qa/server.py`
- Create: `qa/renderer/index.html`
- Create: `qa/renderer/app.js`
- Create: `qa/renderer/styles.css`
- Create: `tests_js/renderer.test.mjs`
- Test: `tests/test_qa_server_oracle.py`

- [ ] **Step 1: Write the failing browser test**

Create `tests_js/renderer.test.mjs` that writes the compiled synthetic fixture into a `mkdtemp` directory, starts `python3 -m qa.server --fixture /tmp/job-apply-renderer-test/fixture.json --port 0` using the actual temporary path, reads the JSON startup line, and launches Playwright Chromium. Define these helpers in that file before the test:

```javascript
async function expectValidation(page, labels) {
  for (const label of labels) {
    assert.equal(await page.getByText(`${label} is required`).isVisible(), true);
  }
}

async function fillCompleteProfile(page) {
  await page.getByLabel('First name').fill('Riley');
  await page.getByLabel('Last name').fill('Example');
  await page.getByLabel('Email address').fill('riley@example.invalid');
  await page.getByLabel('Phone number').fill('202-555-0101');
}
```

The test must assert:

```javascript
await page.goto(server.url);
await page.getByRole('button', { name: 'Continue' }).click();
await expectValidation(page, ['First name', 'Last name', 'Email address', 'Phone number']);
await fillCompleteProfile(page);
await page.getByRole('button', { name: 'Continue' }).click();
await page.setInputFiles('input[type=file]', {
  name: 'synthetic-resume.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4 synthetic replay resume'),
});
await page.getByRole('button', { name: 'Continue' }).click();
assert.equal(await page.getByRole('heading', { name: 'Review application' }).isVisible(), true);
assert.equal(await page.getByText('synthetic-resume.pdf').isVisible(), true);
await page.getByRole('button', { name: 'Submit application' }).click();
const state = await (await fetch(`${server.url}/__qa/state`)).json();
assert.equal(state.finalActionActivations, 1);
assert.equal(page.url(), server.url + '/');
```

- [ ] **Step 2: Run the browser test to verify failure**

Run: `npm install && npx playwright install chromium && npm run test:qa-browser`

Expected: FAIL because `qa.server` and renderer files do not exist.

- [ ] **Step 3: Implement the fixture server**

Create `qa/server.py` using `ThreadingHTTPServer`. Required endpoints:

- `GET /` and renderer assets from the fixed `qa/renderer` directory.
- `GET /__qa/fixture` returns validated fixture JSON.
- `GET /__qa/state` returns `{events, finalActionActivations}`.
- `POST /__qa/event` accepts only `{type, controlId, stepId}` with event types `filled`, `uploaded`, `validation`, `advanced`, `reviewed`.
- `POST /__qa/final-action` increments `finalActionActivations`, records `final-action`, and returns HTTP 409 without a redirect.

Bind to `127.0.0.1`, reject bodies over 64 KiB, set `Cache-Control: no-store`, and print exactly one startup JSON object containing the chosen URL. Do not serve arbitrary filesystem paths.

- [ ] **Step 4: Implement the generic renderer**

`index.html` contains one neutral product title, a main application region, progress text, and no external resources. `app.js` must fetch `/__qa/fixture`, render controls by catalog role, validate required fields, post semantic events without field values, advance declared steps, display the selected filename, and call `/__qa/final-action` from the enabled final button. `styles.css` supplies a generic modal layout with a constrained scroll region and no platform branding.

Keep renderer control construction in focused functions with these signatures:

```javascript
function renderStep(fixture, stepId) {}
function renderControl(control) {}
function validateStep(step) {}
async function recordEvent(type, controlId, stepId) {}
async function activateFinalAction(stepId) {}
```

- [ ] **Step 5: Run deterministic browser tests**

Run: `npm run test:qa-browser`

Expected: all renderer tests PASS, including the 409 tripwire response and unchanged local URL.

- [ ] **Step 6: Commit server and renderer**

```bash
git add qa/server.py qa/renderer tests_js/renderer.test.mjs
git commit -m "feat: serve interactive replay fixtures"
```

### Task 6: Score semantic outcomes and existing storage contracts

**Files:**
- Create: `qa/oracle.py`
- Modify: `tests/test_qa_server_oracle.py`

- [ ] **Step 1: Write failing oracle tests**

Use a temporary store shaped like the current helper output. Test one passing run and failures for a missing field event, missing upload, absent review event, `completed` history, a session containing any nested `value` key, and nonzero tripwire count.

```python
report = evaluate_run(fixture, scenario, events, store_root)
self.assertEqual(report["status"], "passed")
self.assertEqual(report["assertions"]["final-action-untouched"], "passed")
self.assertNotIn("Synthetic Person", json.dumps(report))
```

- [ ] **Step 2: Run oracle tests to verify failure**

Run: `python3 -m unittest tests.test_qa_server_oracle -v`

Expected: FAIL because `qa.oracle` does not exist.

- [ ] **Step 3: Implement the redacted oracle**

Create `qa/oracle.py` with:

```python
def evaluate_run(
    fixture: dict,
    scenario: dict,
    events: list[dict],
    store_root: Path,
) -> dict:
    """Return assertion names/statuses and stable IDs; never return answer values."""
```

The complete-profile oracle requires one `filled` event for every required non-file control, one `uploaded` event for `resume.file`, one `reviewed` event, `finalActionActivations == 0`, history containing `started` and `reviewed` but not `completed`, and every session tree to contain no key named `value` or ending in `Value`. Report only fixture/scenario IDs, assertion statuses, and missing stable IDs.

- [ ] **Step 4: Run Python and browser suites**

Run: `python3 -m unittest discover -s tests -v && npm run test:qa-browser`

Expected: all tests PASS.

- [ ] **Step 5: Commit the oracle**

```bash
git add qa/oracle.py tests/test_qa_server_oracle.py
git commit -m "feat: score replay outcomes"
```

### Task 7: Add the assisted CDP recorder

**Files:**
- Create: `qa/recorder.mjs`
- Create: `tests_js/recorder.test.mjs`

- [ ] **Step 1: Write failing recorder unit tests**

Export and test these pure functions before testing CDP attachment:

```javascript
assert.deepEqual(sanitizeObservedControl({
  role: 'textbox', label: 'Private Person email', value: 'private@example.com', required: true,
}), { role: 'textbox', sourceLabel: 'Private Person email', required: true });

assert.throws(
  () => validateRecorderOptions({ output: 'qa/fixtures/bad', cdpUrl: 'http://localhost:9222' }),
  /output must be inside .qa-private/,
);
```

Also test that cookie, authorization, storage, file bytes, input values, and password controls never appear in event JSON.

- [ ] **Step 2: Run recorder tests to verify failure**

Run: `npm run test:qa-browser`

Expected: FAIL because `qa/recorder.mjs` does not exist.

- [ ] **Step 3: Implement CDP attachment and private capture**

Create `qa/recorder.mjs` with two modes:

```text
node qa/recorder.mjs record --cdp-url http://127.0.0.1:9222 --output .qa-private/qa-session-20260811-001
node qa/recorder.mjs checkpoint --session .qa-private/qa-session-20260811-001 --kind application-opened
```

`record` must connect with `chromium.connectOverCDP`, require exactly one selected HTTP(S) page, refuse login/password/CAPTCHA/MFA pages by title/URL/control inspection, attach capture listeners, and keep running until interrupted. Observed events contain timestamp, page sequence, semantic role, source label, requiredness, and interaction type—but never the input value.

`checkpoint` must allow only `application-opened`, `step-advanced`, `validation-observed`, `review-reached`, and `final-action-boundary`. It asks the running recorder to write a private `page.html`, screenshot, visible-control inventory, and checkpoint metadata. It must not capture network headers, cookies, browser storage, response bodies, or uploaded file bytes in Milestone 1.

Write files with user-only permissions on POSIX. On shutdown, emit `capture-receipt.json` containing recorder version, capture ID, capture month, checkpoint kinds, and no source URL.

- [ ] **Step 4: Add an integration test with a local CDP browser**

Launch Chromium with `--remote-debugging-port=0`, serve a synthetic login page and application page, attach the recorder, and verify it refuses the login page but records role/label metadata on the application page without values. Use a temporary `.qa-private`-named directory so the path guard remains exercised.

- [ ] **Step 5: Run recorder and renderer tests**

Run: `npm run test:qa-browser`

Expected: recorder and renderer tests PASS.

- [ ] **Step 6: Commit the recorder**

```bash
git add qa/recorder.mjs tests_js/recorder.test.mjs
git commit -m "feat: record assisted application evidence"
```

### Task 8: Require human approval and destroy raw captures

**Files:**
- Create: `qa/promote.py`
- Test: `tests/test_qa_promotion.py`

- [ ] **Step 1: Write failing promotion tests**

Add five named tests: `test_missing_approval_blocks_promotion`, `test_fixture_hash_mismatch_blocks_promotion`, `test_privacy_failure_blocks_promotion`, `test_success_promotes_and_deletes_private_session`, and `test_atomic_failure_preserves_existing_fixture`. The success test must assert creation of `qa/fixtures/linkedin-easy-apply-short-2026-08-v1/fixture.json`, `provenance.json`, and `approval.json`, followed by absence of the raw session. The atomic test patches `os.replace` to raise `OSError("synthetic failure")` and asserts the prior fixture bytes remain unchanged.

- [ ] **Step 2: Run tests to verify failure**

Run: `python3 -m unittest tests.test_qa_promotion -v`

Expected: FAIL because `qa.promote` does not exist.

- [ ] **Step 3: Implement the promotion command**

Create `qa/promote.py` with subcommands:

```text
python3 -m qa.promote compile --capture .qa-private/qa-session-20260811-001 --fixture-id linkedin-easy-apply-short-2026-08-v1 --candidate .qa-private/qa-session-20260811-001/candidate
python3 -m qa.promote approve --candidate .qa-private/qa-session-20260811-001/candidate --reviewer qa-owner
python3 -m qa.promote promote --candidate .qa-private/qa-session-20260811-001/candidate --destination qa/fixtures
```

`compile` reads only `semantic.json` and `capture-receipt.json`, calls `compile_capture`, writes the candidate, runs `scan_tree`, and produces `review-manifest.json` listing every durable path/string category without source values. `approve` records reviewer, fixture SHA-256, compiler/scanner versions, and timestamp. `promote` revalidates the hash, contract, privacy scan, and approval; atomically installs the fixture; writes the non-sensitive provenance receipt; and removes the entire raw session with explicit resolved-path guards requiring exactly one child directory below `.qa-private/`.

- [ ] **Step 4: Run promotion and privacy suites**

Run: `python3 -m unittest tests.test_qa_promotion tests.test_qa_privacy tests.test_qa_compiler -v`

Expected: all tests PASS.

- [ ] **Step 5: Commit promotion**

```bash
git add qa/promote.py tests/test_qa_promotion.py
git commit -m "feat: gate and promote replay fixtures"
```

### Task 9: Add the supervised advisory replay coordinator

**Files:**
- Create: `scripts/qa-replay.py`
- Test: `tests/test_qa_replay_cli.py`

- [ ] **Step 1: Write failing CLI tests**

Test `prepare` with a fixture and synthetic scenario. Assert it creates a temporary isolated store, starts the server, and prints a JSON object with `fixtureId`, `scenarioId`, `url`, `storeRoot`, and an exact suggested prompt. Test `evaluate` reads server state/store, writes a redacted report under `qa/runs/`, and returns exit 0 for pass or 1 for assertion failure.

- [ ] **Step 2: Run tests to verify failure**

Run: `python3 -m unittest tests.test_qa_replay_cli -v`

Expected: FAIL because `scripts/qa-replay.py` does not exist.

- [ ] **Step 3: Implement coordinator commands**

Implement:

```text
python3 scripts/qa-replay.py prepare --fixture linkedin-easy-apply-short-2026-08-v1 --scenario complete-profile
python3 scripts/qa-replay.py evaluate --run-id qa-run-20260811-001
```

`prepare` copies a checked-in synthetic profile and resume into a new ignored run directory, initializes the store through `scripts/job-apply-store.py --root`, starts `qa.server`, and prints this prompt with the actual URL substituted:

```text
Use job-apply:job-apply on this approved local LinkedIn Easy Apply QA fixture: {fixture_url}. Use the isolated QA profile already prepared for this run. Operate the visible form normally and stop at final review exactly as you would on a live application.
```

Do not invoke Codex or Claude automatically in Milestone 1. The tester invokes the normal installed/working-tree skill in a visible host session. `evaluate` calls `evaluate_run` and writes only synthetic/redacted results.

- [ ] **Step 4: Run coordinator tests**

Run: `python3 -m unittest tests.test_qa_replay_cli -v`

Expected: all tests PASS.

- [ ] **Step 5: Commit the coordinator**

```bash
git add scripts/qa-replay.py tests/test_qa_replay_cli.py
git commit -m "feat: coordinate advisory plugin replays"
```

### Task 10: Wire deterministic QA into CI and documentation

**Files:**
- Modify: `.github/workflows/validate.yml`
- Modify: `scripts/smoke-plugin.sh`
- Modify: `README.md`

- [ ] **Step 1: Add deterministic workflow steps**

After Node setup and before plugin installation, add:

```yaml
      - name: Install QA dependencies
        run: npm ci

      - name: Install replay browser
        run: npx playwright install --with-deps chromium

      - name: Run Python tests
        run: python3 -m unittest discover -s tests -v

      - name: Run deterministic replay browser tests
        run: npm run test:qa-browser
```

- [ ] **Step 2: Extend static smoke assertions**

Add assertions to `scripts/smoke-plugin.sh` that `.qa-private/` and `qa/runs/` are ignored, `qa/fixtures/` is not ignored, and every tracked fixture contains only the allowed durable files. The smoke script must fail if `git ls-files` reports a path below `.qa-private` or `qa/runs`.

- [ ] **Step 3: Document the developer workflow**

Add a `## Replay QA (developers)` section to `README.md` that states:

1. Source recording is permitted only for a genuine user-intended application after manual login.
2. Start a dedicated Chrome profile with remote debugging; never reuse a profile containing unrelated tabs.
3. Record and annotate into `.qa-private/`.
4. Compile, inspect `review-manifest.json`, approve, and promote.
5. Confirm raw deletion before staging.
6. Run deterministic checks, then prepare a supervised advisory plugin replay.
7. Never commit source URLs, employer/job identity, screenshots, DOM, applicant values, resumes, cookies, tokens, or raw reports.

Include the exact `qa-session-20260811-001`, `linkedin-easy-apply-short-2026-08-v1`, and `qa-run-20260811-001` command examples from Tasks 7–9 and explain that testers replace those example IDs with unique values for each run.

- [ ] **Step 4: Run the complete deterministic suite**

Run:

```bash
python3 -m unittest discover -s tests -v
npm run test:qa-browser
bash scripts/check-links.sh
git diff --check
```

Expected: all tests and checks PASS.

- [ ] **Step 5: Commit CI and documentation**

```bash
git add .github/workflows/validate.yml scripts/smoke-plugin.sh README.md
git commit -m "ci: validate replay QA fixtures"
```

### Task 11: Produce and validate the first real fixture

**Files:**
- Create through promotion: `qa/fixtures/linkedin-easy-apply-short-2026-08-v1/fixture.json`
- Create through promotion: `qa/fixtures/linkedin-easy-apply-short-2026-08-v1/provenance.json`
- Create through promotion: `qa/fixtures/linkedin-easy-apply-short-2026-08-v1/approval.json`
- Create: `qa/scenarios/complete-profile/profile.json`
- Create: `qa/scenarios/complete-profile/synthetic-resume.pdf`
- Create: `qa/scenarios/complete-profile/expected.json`

- [ ] **Step 1: Create the synthetic complete-profile scenario**

Use reserved `example.com` contact data, a fictional applicant name, Phoenix location, and a one-page synthetic PDF containing no real person, company, school, URL, or employment history. `expected.json` lists stable control IDs and the expected displayed filename; it must not duplicate profile values.

- [ ] **Step 2: Confirm the source application policy**

The tester chooses a current short LinkedIn Easy Apply job they genuinely intend to apply to, signs in manually in a dedicated CDP-enabled QA Chrome profile, closes unrelated tabs, and confirms that advancing may create a live draft. Do not start recording on login, CAPTCHA, MFA, consent, or account-creation pages.

- [ ] **Step 3: Record the supervised walkthrough**

Start the recorder, invoke the normal Job Apply skill, mark `application-opened`, any `step-advanced` checkpoint, `review-reached`, and `final-action-boundary`, and leave the real final action untouched. Stop recording before the user decides whether to submit manually.

- [ ] **Step 4: Author the private semantic mapping**

Inside the ignored capture directory, map every required recorded control to a supported catalog kind. The compiler must reject the fixture if an encountered required control has no catalog kind; extend the catalog through a separate tested commit instead of labeling it approximately.

- [ ] **Step 5: Compile, privacy-scan, and review**

Run the compile command. A human reviewer compares the generic rendered candidate with the private capture for behavior only, inspects every durable string/path in `review-manifest.json`, and runs the full privacy corpus. Do not approve while any unsupported control, unexpected file, or detector finding remains.

- [ ] **Step 6: Approve and promote**

Run the approval and promotion commands. Verify `.qa-private/qa-session-20260811-001` no longer exists and `git status --short` shows only the generic fixture package and synthetic scenario.

- [ ] **Step 7: Run deterministic and advisory acceptance**

Run the complete deterministic suite. Then run `qa-replay.py prepare`, invoke the unchanged Job Apply skill with its suggested prompt, and run `qa-replay.py evaluate`. The advisory report must pass browser filling, resume filename, review state, minimal history/session constraints, and `finalActionActivations == 0`.

- [ ] **Step 8: Commit the approved fixture**

```bash
git add qa/fixtures/linkedin-easy-apply-short-*-v1 qa/scenarios/complete-profile
git diff --cached --check
git commit -m "test: add short Easy Apply replay fixture"
```

Do not commit if any raw capture, source identity, or real applicant artifact appears in `git diff --cached --name-only` or the privacy scan.

### Task 12: Final verification and Milestone 1 handoff

**Files:**
- No new files expected

- [ ] **Step 1: Run all repository verification**

```bash
python3 -m unittest discover -s tests -v
npm run test:qa-browser
bash scripts/smoke-plugin.sh
bash scripts/check-links.sh
git diff --check
git status --short
```

Expected: every check passes and the worktree is clean.

- [ ] **Step 2: Audit tracked paths for private evidence**

Run:

```bash
git ls-files | rg '(^|/)(\.qa-private|runs|screenshots|page\.html|capture-receipt\.json)($|/)'
```

Expected: no output and exit 1.

- [ ] **Step 3: Confirm acceptance evidence**

Confirm the checked-in fixture passes deterministic replay, the advisory plugin report passes, the promoted provenance contains no source URL/company/role/applicant fields, raw capture is absent, and the enabled final action was never activated.

- [ ] **Step 4: Record the milestone boundary**

Open the follow-on planning issue or design note for Milestone 2 using observed unsupported controls and drift—not speculative component additions. Do not implement Milestone 2 in this branch.
