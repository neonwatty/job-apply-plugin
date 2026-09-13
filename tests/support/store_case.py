import copy
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from tests.support import store_fixtures


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "job-apply-store.py"
SPEC = importlib.util.spec_from_file_location("job_apply_store", SCRIPT)
STORE_MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(STORE_MODULE)


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.root = self.home / ".job-apply"
        self.legacy = self.home / ".claude-job-profile.json"
        self.store = STORE_MODULE.Store(self.root, self.legacy)
        self._observer_outcomes = {}

    def tearDown(self):
        self.temporary.cleanup()

    def review_session(
        self, attempt_revision, step="review",
        fixture_id="greenhouse-form-readiness-v1",
    ):
        return store_fixtures.review_session(
            STORE_MODULE, attempt_revision, step, fixture_id,
        )

    @staticmethod
    def legacy_1_2_session(application_id="legacy-session", pending_fields=None):
        return store_fixtures.legacy_1_2_session(application_id, pending_fields)

    def _write_legacy_search_report(self, name="search-2026-08-24T12-00-00.md"):
        legacy_root = self.home / ".claude-job-searches"
        legacy_root.mkdir(exist_ok=True)
        path = legacy_root / name
        path.write_text(
            """# Job Search Results — 2026-08-24

## Results (ranked by score)

### 1. Staff Engineer — Acme Corp (Score: 92)
- **Source**: LinkedIn
- **Location**: Remote
- **Salary**: $250K
- **Description**: Build reliable systems.
- **Apply**: Easy Apply
- **URL**: https://example.com/jobs/staff#apply

### 2. Missing Link — Example Co (Score: 75)
- **Source**: Hacker News
- **Apply**: Ask the poster
""",
            encoding="utf-8",
        )
        return path

    def _make_ready_job(self, job_id="ready-job", assigned=False, ats=None):
        self.store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=self.store.inspect_profile()["revision"],
            source="user",
        )
        default_path = self.home / "default.pdf"
        default_path.write_bytes(b"%PDF-1.7\ndefault-resume")
        self.store.create_resume(
            {"id": "default-resume", "label": "Default", "path": str(default_path)}
        )
        resume_id = None
        if assigned:
            assigned_path = self.home / "assigned.pdf"
            assigned_path.write_bytes(b"%PDF-1.7\nassigned-resume")
            assigned_resume = self.store.create_resume(
                {"id": "assigned-resume", "label": "Assigned", "path": str(assigned_path)}
            )
            resume_id = assigned_resume["id"]
        payload = {
            "id": job_id, "url": f"https://example.com/jobs/{job_id}",
            "role": "Engineer", "company": "Acme", "resumeId": resume_id,
        }
        if ats is not None:
            payload["ats"] = ats
        job = self.store.create_job(payload)
        return self.store.transition_job(job_id, "ready", job["revision"])

    def _make_reviewed_job(self, job_id="reviewed-job"):
        ready = self._make_ready_job(job_id=job_id, ats="greenhouse")
        acquired = self.store.acquire_ready_job(
            job_id, "initial-agent", ready["revision"]
        )
        return self.store.handoff_claimed_job(
            job_id,
            acquired["token"],
            "awaiting_review",
            self.review_session(acquired["job"]["revision"]),
            acquired["job"]["revision"],
        )["job"]

    def _replace_with_legacy_review_session(self, job, **overrides):
        session = {
            "schemaVersion": 1,
            "applicationId": job["id"],
            "status": "review",
            "step": "final_review",
            "answerKeys": [],
            "pendingFields": [],
            "createdAt": "2026-08-01T00:00:00Z",
            "updatedAt": "2026-08-01T00:01:00Z",
        }
        session.update(overrides)
        path = self.store._session_path(job["id"])
        path.write_text(
            json.dumps(session, separators=(",", ":")), encoding="utf-8"
        )
        return path

    def _prepared_workday_canary(self, suffix, *, strategy="unique_per_realm"):
        store = STORE_MODULE.Store(self.home / f".job-apply-workday-{suffix}", self.legacy)
        store.initialize()
        store.replace_profile(
            {"firstName": "Synthetic"}, store.inspect_profile()["revision"], "user"
        )
        resume_path = self.home / f"workday-{suffix}.txt"
        resume_path.write_text("Synthetic", encoding="utf-8")
        resume = store.create_resume({
            "id": f"workday-{suffix}", "label": "Synthetic", "path": str(resume_path),
        })
        url = f"https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Phoenix/Engineer_{suffix}"
        job = store.create_job({
            "id": f"workday-job-{suffix}", "url": url, "role": "Synthetic",
            "company": "Synthetic", "resumeId": resume["id"],
        })
        ready = store.transition_job(job["id"], "ready", job["revision"])
        acquired = store.acquire_ready_job(job["id"], "workday-test", ready["revision"])
        settings = store.get_automation_settings()
        settings = store.update_automation_settings({
            "enabled": True, "automaticAccountCreation": True,
            "signupEmail": "private@example.invalid", "passwordStrategy": strategy,
        }, settings["revision"])
        realm = store.resolve_account_realm(url)
        account = store.create_employer_account(url)
        controls = {
            "accountFormFingerprint": "sha256:" + "1" * 64,
            "emailControlFingerprint": "sha256:" + "2" * 64,
            "passwordControlFingerprint": "sha256:" + "3" * 64,
            "createAccountControlFingerprint": "sha256:" + "4" * 64,
        }
        aggregate = "sha256:" + hashlib.sha256(
            ":".join(controls.values()).encode()
        ).hexdigest()
        portal_name = "Acme Workday"
        binding = {
            "jobId": job["id"], "jobRevision": acquired["job"]["revision"],
            "realmRef": realm["realmRef"], "accountRevision": account["revision"],
            "settingsRevision": settings["revision"],
            "portalFingerprint": "sha256:" + hashlib.sha256(url.encode()).hexdigest(),
            "portalNameFingerprint": "sha256:" + hashlib.sha256(portal_name.encode()).hexdigest(),
            "accountCreationControlsFingerprint": aggregate,
            "approvalRevision": 1, "flowKind": "password_candidate_account",
            **controls,
        }
        request = {
            "binding": binding, "portalName": portal_name, "portalUrl": url, **controls,
        }
        return store, request, account

    def _live_oracle_adversarial_fixture(self, label):
        root = self.home / f"live-oracle-adversarial-{label}"
        store = STORE_MODULE.Store(root, self.home / f"legacy-{label}.json")
        store.initialize()
        store.replace_profile(
            {"firstName": "Synthetic"}, store.inspect_profile()["revision"], "user"
        )
        resume_path = self.home / f"live-oracle-adversarial-{label}.txt"
        resume_path.write_text("Synthetic", encoding="utf-8")
        resume = store.create_resume({
            "id": f"resume-{label}", "label": "Synthetic", "path": str(resume_path),
        })
        oracle_job_number = int(hashlib.sha256(label.encode("utf-8")).hexdigest()[:8], 16)
        url = (
            "https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/"
            f"en/sites/jobsearch/job/{oracle_job_number}/apply/email"
        )
        job = store.create_job({
            "id": f"job-{label}", "url": url, "role": "Synthetic",
            "company": "Synthetic", "resumeId": resume["id"],
        })
        ready = store.transition_job(job["id"], "ready", job["revision"])
        acquired = store.acquire_ready_job(job["id"], "oracle-adversarial", ready["revision"])
        settings = store.get_automation_settings()
        settings = store.update_automation_settings({
            "enabled": True, "automaticAccountCreation": True,
            "signupEmail": "synthetic-owner@example.invalid",
        }, settings["revision"])
        realm = store.resolve_account_realm(url)
        account = store.create_employer_account(url)
        controls = {
            "accountFormFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("form"),
            "emailControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("email"),
            "termsControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("terms"),
            "termsDocumentFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("document"),
            "nextControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("next"),
        }
        portal_name = "Oracle Recruiting"
        binding = {
            "jobId": job["id"], "jobRevision": acquired["job"]["revision"],
            "realmRef": realm["realmRef"], "accountRevision": account["revision"],
            "settingsRevision": settings["revision"],
            "portalFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint(url),
            "portalNameFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint(portal_name),
            "accountCreationControlsFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint(
                ":".join(controls.values())
            ),
            "approvalRevision": 1, "flowKind": "email_only_candidate_profile",
            **controls, "passwordControlFingerprint": None,
            "createAccountControlFingerprint": None,
        }
        request = {
            "binding": binding, "portalName": portal_name, "portalUrl": url,
            **controls, "passwordControlFingerprint": None,
            "createAccountControlFingerprint": None,
        }
        return store, request, acquired["claim"]["claimId"]

    @staticmethod
    def _expire_live_claim(store):
        coordinator = store._load_coordinator_document()
        coordinator["claim"]["expiresAt"] = "2000-01-01T00:00:00Z"
        STORE_MODULE.atomic_write_json(store.coordinator_path, coordinator)

    def _trusted_fill_fixture(self, suffix: str, answer_refs=None):
        resume_path = self.home / f"trusted-fill-{suffix}.txt"
        resume_path.write_text(f"Synthetic resume {suffix}", encoding="utf-8")
        self.store.replace_profile(
            {"firstName": "Synthetic"},
            self.store.inspect_profile()["revision"],
            "user",
        )
        resume = self.store.create_resume({
            "id": f"trusted-resume-{suffix}", "label": "Synthetic",
            "path": str(resume_path),
        })
        job = self.store.create_job({
            "id": f"trusted-job-{suffix}",
            "url": f"https://acme.wd5.myworkdayjobs.com/jobs/{suffix}",
            "role": "Engineer", "company": "Synthetic", "resumeId": resume["id"],
        })
        ready = self.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.store.acquire_ready_job(job["id"], "trusted-fill-test", ready["revision"])
        fingerprint = lambda char: "sha256:" + char * 64
        approval = self.store.approve_trusted_fill({
            "jobId": job["id"], "expectedJobRevision": acquired["job"]["revision"],
            "realmRef": self.store.resolve_account_realm(job["url"])["realmRef"],
            "answerRefs": answer_refs or [], "observedQuestionFingerprint": fingerprint("1"),
            "observedControlFingerprint": fingerprint("2"),
            "formFingerprint": fingerprint("3"),
            "allowedOperations": ["fill_text"], "durationMinutes": 30,
        })
        evaluation = {
            "jobId": job["id"], "expectedApprovalRevision": approval["approvalRevision"],
            "observedQuestionFingerprint": fingerprint("1"),
            "observedControlFingerprint": fingerprint("2"),
            "formFingerprint": fingerprint("3"), "fieldOperations": ["fill_text"],
            "authenticationRequired": False, "consentRequired": False,
            "credentialFieldsPresent": False, "finalControlsPresent": False,
            "unseenQuestions": False, "unseenControls": False,
        }
        return resume, job, acquired, approval, evaluation

    def _synthetic_account_fixture(self, outcome="success", suffix="one"):
        source = self.home / f"account-{suffix}.txt"
        source.write_text(f"Synthetic resume {suffix}", encoding="utf-8")
        self.store.replace_profile(
            {"firstName": "Synthetic"}, self.store.inspect_profile()["revision"], "user"
        )
        resume = self.store.create_resume({"id": f"account-resume-{suffix}", "label": "Synthetic", "path": str(source)})
        job = self.store.create_job({
            "id": f"account-job-{suffix}",
            "url": f"https://acme.wd5.myworkdayjobs.com/jobs/{suffix}",
            "role": "Engineer", "company": "Synthetic", "resumeId": resume["id"],
        })
        ready = self.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.store.acquire_ready_job(job["id"], "account-test", ready["revision"])
        settings = self.store.get_automation_settings()
        if not settings["enabled"]:
            settings = self.store.update_automation_settings(
                {"enabled": True, "automaticAccountCreation": True, "signupEmail": "synthetic@example.invalid"},
                settings["revision"],
            )
        realm = self.store.resolve_account_realm(job["url"])
        account = self.store.get_employer_account(realm["realmRef"])
        if account is None:
            account = self.store.create_employer_account(job["url"])
        base_target = "http://127.0.0.1:43123/synthetic-account"
        control = STORE_MODULE.ACCOUNT_EXECUTOR_MODULE.synthetic_proofs(base_target, outcome)["secureControlFingerprint"]
        operation = STORE_MODULE.ACCOUNT_EXECUTOR_MODULE.operation_fingerprint(base_target, realm["realmRef"], control)
        target = base_target + "?operation=" + operation.removeprefix("sha256:")
        self._observer_outcomes[operation.removeprefix("sha256:")] = outcome
        proofs = STORE_MODULE.ACCOUNT_EXECUTOR_MODULE.synthetic_proofs(target, outcome)
        packet = {
            "jobId": job["id"], "expectedJobRevision": acquired["job"]["revision"],
            "expectedClaimId": acquired["claim"]["claimId"], "realmRef": realm["realmRef"],
            "realmDescriptor": realm["descriptor"], "expectedSettingsRevision": settings["revision"],
            "expectedAccountRevision": account["revision"], "syntheticTargetUrl": target,
            **proofs,
        }
        return job, acquired, account, packet

    def _synthetic_account_observer(self, target, _token):
        operation = __import__("urllib.parse", fromlist=["parse_qs", "urlsplit"]).parse_qs(
            __import__("urllib.parse", fromlist=["urlsplit"]).urlsplit(target).query
        )["operation"][0]
        outcome = self._observer_outcomes[operation]
        proofs = STORE_MODULE.ACCOUNT_EXECUTOR_MODULE.synthetic_proofs(target, outcome)
        return {
            "portalState": outcome,
            "lifecycleState": STORE_MODULE.ACCOUNT_EXECUTOR_MODULE.OUTCOMES[outcome],
            "formFingerprint": proofs["observedFormFingerprint"],
            "controlFingerprint": proofs["observedControlFingerprint"],
        }
