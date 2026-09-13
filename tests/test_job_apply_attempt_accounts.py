from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


STORE = load_module(
    "job_apply_attempt_account_store_tests", ROOT / "scripts" / "job-apply-store.py"
)
ATTEMPT = load_module(
    "job_apply_attempt_account_tests", ROOT / "scripts" / "job-apply-attempt.py"
)


class AttemptAccountFlowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = STORE.Store(self.root / "store")
        profile = self.store.inspect_profile()
        self.store.replace_profile(
            {"firstName": "Private"}, profile["revision"], "user"
        )
        resume_path = self.root / "resume.txt"
        resume_path.write_text("private resume", encoding="utf-8")
        self.store.create_resume({
            "id": "resume", "label": "Resume", "path": str(resume_path),
        })
        self.brokers: list[object] = []

    def tearDown(self):
        for broker in self.brokers:
            broker.close()
        self.temporary.cleanup()

    def ready_job(self, job_id: str, url: str) -> dict:
        job = self.store.create_job({"id": job_id, "url": url})
        return self.store.transition_job(job_id, "ready", job["revision"])

    def broker(self):
        broker = ATTEMPT.AttemptBroker(self.store.root, heartbeat_seconds=3600)
        self.brokers.append(broker)
        return broker

    @staticmethod
    def start_request(job: dict) -> dict:
        return {
            "command": "start", "id": job["id"], "owner": "account-test",
            "expectedRevision": job["revision"],
        }

    def configure_accounts(self, **overrides) -> dict:
        settings = self.store.get_automation_settings()
        patch = {
            "enabled": True, "automaticAccountCreation": True,
            "signupEmail": "private@example.invalid",
            **overrides,
        }
        return self.store.update_automation_settings(patch, settings["revision"])

    def test_reviewed_accountless_flow_proceeds_with_closed_value_free_plan(self):
        job = self.ready_job(
            "greenhouse", "https://boards.greenhouse.io/acme/jobs/12345"
        )
        response = self.broker().acquire(self.start_request(job))

        self.assertEqual(response["event"], "acquired")
        self.assertEqual(response["attempt"]["accountFlow"], {
            "jobId": "greenhouse", "decision": "account_not_required",
            "adapterId": "greenhouse", "flowKind": "account_not_required",
            "accountRevision": None, "action": "proceed",
            "reasonCode": "account_not_required", "finalActionAuthorized": False,
        })
        serialized = json.dumps(response["attempt"]["accountFlow"])
        for forbidden in ("https://", "signupEmail", "credential", "realmRef"):
            self.assertNotIn(forbidden, serialized)

    def test_workday_requires_reviewed_canary_and_releases_claim(self):
        self.configure_accounts(passwordStrategy="unique_per_realm")
        job = self.ready_job(
            "workday",
            "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/One",
        )
        with mock.patch.object(ATTEMPT.sys, "platform", "darwin"):
            response = self.broker().acquire(self.start_request(job))

        self.assertEqual(response["event"], "account_attention")
        self.assertEqual(response["accountFlow"]["reasonCode"], "reviewed_canary_required")
        self.assertFalse(response["accountFlow"]["finalActionAuthorized"])
        self.assertEqual(response["job"]["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        session = self.store.load_session(job["id"])
        self.assertEqual(session["browserHandoff"], {
            "state": "required", "reasonCode": "unsupported-control", "revision": 1,
        })

    def test_oracle_action_hands_off_and_releases_claim(self):
        self.configure_accounts()
        job = self.ready_job(
            "oracle",
            "https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/"
            "en/sites/jobsearch/job/331081/apply/email",
        )
        broker = self.broker()
        with mock.patch.object(ATTEMPT.sys, "platform", "darwin"):
            response = broker.acquire(self.start_request(job))

        plan = response["accountFlow"]
        self.assertEqual((plan["action"], plan["reasonCode"]), (
            "account_action_required", "account_record_required",
        ))
        self.assertEqual(response["event"], "account_attention")
        self.assertEqual(response["job"]["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        self.assertEqual(
            self.store.load_session(job["id"])["browserHandoff"]["reasonCode"],
            "account-creation-required",
        )

    def test_unresolved_secret_bearing_url_hands_off_without_disclosure(self):
        secret = "never-serialize-this"
        job = self.ready_job(
            "unknown", f"https://jobs.example.com/apply?access_token={secret}"
        )
        response = self.broker().acquire(self.start_request(job))

        self.assertEqual(response["event"], "account_attention")
        self.assertEqual(response["accountFlow"]["reasonCode"], "account_flow_unresolved")
        self.assertIsNone(self.store.claim_status()["claim"])
        serialized = json.dumps(response)
        self.assertNotIn(secret, serialized)
        self.assertNotIn("https://", serialized)


if __name__ == "__main__":
    unittest.main()
