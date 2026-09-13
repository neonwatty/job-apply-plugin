import importlib.util
import hmac
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "job_apply_policy.py"
SPEC = importlib.util.spec_from_file_location("job_apply_policy", SCRIPT)
POLICY = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(POLICY)


def fingerprint(label):
    import hashlib

    return "sha256:" + hashlib.sha256(label.encode()).hexdigest()


def reference(kind, label):
    return f"{kind}:" + fingerprint(label).split(":", 1)[1]


NOW = datetime(2026, 8, 14, 16, 0, tzinfo=timezone.utc)
CONFIRMATION_CAPABILITY = "d" * 64


class PolicyCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / ".job-apply"
        self.store = POLICY.PolicyStore(self.root)
        self.application_ref = reference("application", "acme-engineer")
        self.answer_ref = reference("answer", "work-auth")
        self.rule = {
            "applicationRef": self.application_ref,
            "origin": "https://jobs.example.test",
            "urlFingerprint": fingerprint("https://jobs.example.test/123"),
            "ats": "greenhouse",
            "jobFingerprint": fingerprint("job-123"),
            "formRevision": fingerprint("form-v1"),
            "finalControlRevision": fingerprint("submit-button-v1"),
        }
        self.sensitive = {
            "answerRef": self.answer_ref,
            "questionRevision": fingerprint("authorized-question-v1"),
            "answerRevision": fingerprint("authorized-answer-v1"),
        }

    def tearDown(self):
        self.temporary.cleanup()

    def campaign_input(self, **changes):
        value = {
            "riskAcknowledged": True,
            "applicationRules": [self.rule],
            "resumeRevision": fingerprint("resume-v1"),
            "sensitiveAllowlist": [self.sensitive],
            "confirmationAuthorityRevision": POLICY.confirmation_authority_revision(
                CONFIRMATION_CAPABILITY
            ),
        }
        value.update(changes)
        return value

    def authorization(self, **changes):
        value = {
            **self.rule,
            "resumeRevision": fingerprint("resume-v1"),
            "formRevision": fingerprint("form-v1"),
            "finalControlRevision": fingerprint("submit-button-v1"),
            "answerRevisions": [self.sensitive],
        }
        value.update(changes)
        return value

    def activate(self, **changes):
        return self.store.activate(self.campaign_input(**changes), now=NOW)

    def claim(self, lease, now=NOW, authorization=None):
        return self.store.claim_final_action(
            self.application_ref,
            lease["leaseId"],
            lease["attempt"],
            authorization or self.authorization(),
            CONFIRMATION_CAPABILITY,
            now=now,
        )

    def confirmation(self, claim, label="confirmation-page"):
        event = {
            "eventId": reference("receipt", f"event-{label}"),
            "claimId": claim["claimId"],
            "source": "isolated_loopback",
            "observedAt": POLICY.format_time(NOW),
            "confirmationRevision": fingerprint(label),
            "activationObserved": True,
        }
        event["proof"] = hmac.new(
            CONFIRMATION_CAPABILITY.encode(),
            json.dumps(event, sort_keys=True, separators=(",", ":")).encode(),
            __import__("hashlib").sha256,
        ).hexdigest()
        return event
