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


ROOT = Path(__file__).resolve().parents[1]
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


class PolicyTests(unittest.TestCase):
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

    def test_missing_legacy_future_and_corrupt_state_fail_to_review_only(self):
        self.assertEqual(self.store.decision(now=NOW)["mode"], "review_only")
        self.store.policy_dir.mkdir(parents=True)
        for payload in (
            {"schemaVersion": 0, "mode": "auto_submit"},
            {"schemaVersion": 99, "mode": "auto_submit"},
        ):
            self.store.campaign_path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(self.store.decision(now=NOW)["mode"], "review_only")
        self.store.campaign_path.write_text("not json", encoding="utf-8")
        self.assertEqual(self.store.decision(now=NOW)["mode"], "review_only")

    def test_activation_defaults_are_bounded_closed_and_scope_is_immutable(self):
        campaign = self.activate()
        self.assertEqual(campaign["mode"], "auto_submit")
        self.assertEqual(campaign["maxApplications"], 10)
        self.assertEqual(
            POLICY.parse_time(campaign["expiresAt"]) - POLICY.parse_time(campaign["createdAt"]),
            timedelta(hours=4),
        )
        self.assertEqual(set(campaign), POLICY.CAMPAIGN_FIELDS)
        with self.assertRaises(POLICY.PolicyError):
            self.store.activate(self.campaign_input(maxApplications=11), now=NOW)
        with self.assertRaises(POLICY.PolicyError):
            self.store.activate(self.campaign_input(applicationRules=[]), now=NOW)
        self.assertEqual(self.store.load_campaign(), campaign)

    def test_activation_recovers_matching_archive_after_interruption(self):
        previous = self.store.activate(
            self.campaign_input(durationSeconds=1), now=NOW
        )
        later = NOW + timedelta(seconds=2)
        original_atomic_json = POLICY._atomic_json

        def interrupt_after_archive(path, value):
            original_atomic_json(path, value)
            if path.parent == self.store.archive_dir:
                raise RuntimeError("injected interruption")

        with mock.patch.object(POLICY, "_atomic_json", interrupt_after_archive):
            with self.assertRaisesRegex(RuntimeError, "injected interruption"):
                self.store.activate(self.campaign_input(), now=later)

        restarted = POLICY.PolicyStore(self.root)
        replacement = restarted.activate(self.campaign_input(), now=later)
        archive_path = restarted.archive_dir / (
            previous["campaignId"].split(":", 1)[1] + ".json"
        )
        self.assertEqual(json.loads(archive_path.read_text()), previous)
        self.assertEqual(restarted.load_campaign(), replacement)

        mismatch = POLICY.PolicyStore(Path(self.temporary.name) / "mismatch")
        mismatch_previous = mismatch.activate(
            self.campaign_input(durationSeconds=1), now=NOW
        )

        def mismatch_interrupt(path, value):
            original_atomic_json(path, value)
            if path.parent == mismatch.archive_dir:
                raise RuntimeError("injected interruption")

        with mock.patch.object(POLICY, "_atomic_json", mismatch_interrupt):
            with self.assertRaises(RuntimeError):
                mismatch.activate(self.campaign_input(), now=later)
        mismatch_archive = mismatch.archive_dir / (
            mismatch_previous["campaignId"].split(":", 1)[1] + ".json"
        )
        mismatch_archive.write_text(
            json.dumps({**mismatch_previous, "reservedApplications": 1})
        )
        with self.assertRaisesRegex(
            POLICY.PolicyError, "campaign archive already exists"
        ):
            mismatch.activate(self.campaign_input(), now=later)

    def test_campaign_rejects_private_or_unclosed_metadata(self):
        for changes in (
            {"answerValue": "secret"},
            {"applicationRules": [{**self.rule, "url": "https://private.test/token"}]},
            {"sensitiveAllowlist": [{**self.sensitive, "answer": "secret"}]},
            {"resumeRevision": "resume text"},
        ):
            with self.subTest(changes=changes):
                with self.assertRaises(POLICY.PolicyError):
                    self.store.activate(self.campaign_input(**changes), now=NOW)

    def test_exact_scope_sensitive_and_revision_mismatch_fail_closed(self):
        self.activate()
        variants = (
            {"origin": "https://evil.example.test"},
            {"urlFingerprint": fingerprint("redirect")},
            {"jobFingerprint": fingerprint("different-job")},
            {"resumeRevision": fingerprint("resume-v2")},
            {"formRevision": "bad"},
            {"finalControlRevision": fingerprint("different-control")},
            {"answerRevisions": [{**self.sensitive, "answerRevision": fingerprint("changed")}]},
        )
        for changes in variants:
            with self.subTest(changes=changes):
                self.assertEqual(
                    self.store.authorize(self.authorization(**changes), now=NOW)["mode"],
                    "review_only",
                )
        self.assertFalse(self.store.applications_dir.exists())

    def test_atomic_reservation_limit_restart_and_idempotency(self):
        rules = []
        for number in range(3):
            rules.append(
                {
                    **self.rule,
                    "applicationRef": reference("application", f"app-{number}"),
                    "urlFingerprint": fingerprint(f"url-{number}"),
                    "jobFingerprint": fingerprint(f"job-{number}"),
                }
            )
        self.store.activate(
            self.campaign_input(maxApplications=2, applicationRules=rules), now=NOW
        )
        barrier = threading.Barrier(3)

        def reserve(rule):
            local = POLICY.PolicyStore(self.root)
            request = self.authorization(
                applicationRef=rule["applicationRef"],
                urlFingerprint=rule["urlFingerprint"],
                jobFingerprint=rule["jobFingerprint"],
            )
            barrier.wait()
            return local.authorize(request, now=NOW)

        with ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(reserve, rules))
        approved = [item for item in results if item["mode"] == "auto_submit"]
        self.assertEqual(len(approved), 2)
        self.assertEqual(sorted(item["slot"] for item in approved), [1, 2])

        winner = approved[0]
        rule = next(item for item in rules if item["applicationRef"] == winner["applicationRef"])
        restarted = POLICY.PolicyStore(self.root)
        same = restarted.authorize(
            self.authorization(
                applicationRef=rule["applicationRef"],
                urlFingerprint=rule["urlFingerprint"],
                jobFingerprint=rule["jobFingerprint"],
            ),
            now=NOW,
        )
        self.assertEqual(same["leaseId"], winner["leaseId"])

    def test_expiry_and_persisted_kill_switch_deny_new_or_existing_work(self):
        campaign = self.activate()
        later = POLICY.parse_time(campaign["expiresAt"]) + timedelta(seconds=1)
        self.assertEqual(self.store.authorize(self.authorization(), now=later)["mode"], "review_only")
        self.store.kill(now=NOW)
        restarted = POLICY.PolicyStore(self.root)
        self.assertEqual(restarted.decision(now=NOW)["mode"], "review_only")
        self.assertEqual(restarted.authorize(self.authorization(), now=NOW)["mode"], "review_only")
        with self.assertRaises(POLICY.PolicyError):
            restarted.revoke(now=NOW)

    def test_tampered_attempt_state_cannot_manufacture_a_retry(self):
        campaign = self.activate()
        self.store.authorize(self.authorization(), now=NOW)
        application_path = self.store._application_path(
            self.application_ref, campaign["campaignId"]
        )
        document = json.loads(application_path.read_text(encoding="utf-8"))
        document["status"] = "retry_available"
        application_path.write_text(json.dumps(document), encoding="utf-8")
        denied = self.store.authorize(
            self.authorization(), now=NOW + timedelta(seconds=1)
        )
        self.assertEqual(denied["mode"], "review_only")
        self.assertEqual(denied["reason"], "policy_unavailable")

    def test_one_retry_then_terminal_uncertain_exhausted(self):
        self.activate()
        first = self.store.authorize(self.authorization(), now=NOW)
        first_claim = self.claim(first)
        result = self.store.record_outcome(
            first_claim["campaignId"],
            self.application_ref,
            first["leaseId"],
            first_claim["claimId"],
            "uncertain",
            now=NOW,
        )
        self.assertEqual(result["status"], "retry_available")
        second = self.store.authorize(self.authorization(), now=NOW + timedelta(seconds=1))
        self.assertNotEqual(second["leaseId"], first["leaseId"])
        self.assertEqual(second["attempt"], 2)
        second_claim = self.claim(second, now=NOW + timedelta(seconds=1))
        exhausted = self.store.record_outcome(
            second_claim["campaignId"],
            self.application_ref,
            second["leaseId"],
            second_claim["claimId"],
            "uncertain",
            now=NOW + timedelta(seconds=2),
        )
        self.assertEqual(exhausted["status"], "uncertain_exhausted")
        restarted = POLICY.PolicyStore(self.root)
        denied = restarted.authorize(self.authorization(), now=NOW + timedelta(seconds=3))
        self.assertEqual(denied["mode"], "review_only")
        self.assertEqual(denied["reason"], "uncertain_exhausted")

    def test_click_is_not_success_confirmation_requires_opaque_evidence(self):
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        claim = self.claim(lease)
        with self.assertRaises(POLICY.PolicyError):
            self.store.record_outcome(
                claim["campaignId"],
                self.application_ref,
                lease["leaseId"],
                claim["claimId"],
                "clicked",
                now=NOW,
            )
        with self.assertRaises(POLICY.PolicyError):
            self.store.record_outcome(
                claim["campaignId"],
                self.application_ref,
                lease["leaseId"],
                claim["claimId"],
                "confirmed_submitted",
                now=NOW,
            )
        confirmed = self.store.record_outcome(
            claim["campaignId"],
            self.application_ref,
            lease["leaseId"],
            claim["claimId"],
            "confirmed_submitted",
            confirmation_event=self.confirmation(claim),
            confirmation_capability=CONFIRMATION_CAPABILITY,
            now=NOW,
        )
        self.assertEqual(confirmed["status"], "confirmed_submitted")

    def test_receipts_are_closed_value_free_and_reject_stale_or_wrong_leases(self):
        secret = "synthetic-private-answer"
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        claim = self.claim(lease)
        receipt = self.store.record_outcome(
            claim["campaignId"],
            self.application_ref,
            lease["leaseId"],
            claim["claimId"],
            "blocked",
            now=NOW,
        )
        repeated = self.store.record_outcome(
            claim["campaignId"],
            self.application_ref,
            lease["leaseId"],
            claim["claimId"],
            "blocked",
            now=NOW,
        )
        self.assertEqual(repeated, receipt)
        self.assertEqual(len(self.store.receipts_path.read_text(encoding="utf-8").splitlines()), 1)
        self.assertEqual(set(receipt), POLICY.RECEIPT_FIELDS)
        self.assertNotIn(secret, json.dumps(receipt))
        self.assertNotIn(secret, self.store.receipts_path.read_text(encoding="utf-8"))
        with self.assertRaises(POLICY.PolicyError):
            self.store.record_outcome(
                claim["campaignId"],
                self.application_ref,
                reference("lease", "wrong"),
                claim["claimId"],
                "blocked",
                now=NOW,
            )

    def test_atomic_action_claim_has_one_winner_and_rechecks_every_boundary(self):
        campaign = self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        barrier = threading.Barrier(2)

        def claim_once():
            barrier.wait()
            try:
                return POLICY.PolicyStore(self.root).claim_final_action(
                    self.application_ref,
                    lease["leaseId"],
                    lease["attempt"],
                    self.authorization(),
                    CONFIRMATION_CAPABILITY,
                    now=NOW,
                )
            except POLICY.PolicyError:
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = list(executor.map(lambda _: claim_once(), range(2)))
        self.assertEqual(sum(claim is not None for claim in claims), 1)

        other_root = Path(self.temporary.name) / "other"
        other = POLICY.PolicyStore(other_root)
        other.activate(self.campaign_input(), now=NOW)
        other_lease = other.authorize(self.authorization(), now=NOW)
        with self.assertRaises(POLICY.PolicyError):
            other.claim_final_action(
                self.application_ref,
                other_lease["leaseId"],
                1,
                self.authorization(finalControlRevision=fingerprint("changed")),
                CONFIRMATION_CAPABILITY,
                now=NOW,
            )
        with self.assertRaises(POLICY.PolicyError):
            other.claim_final_action(
                self.application_ref,
                other_lease["leaseId"],
                1,
                self.authorization(),
                CONFIRMATION_CAPABILITY,
                now=POLICY.parse_time(other_lease["leaseExpiresAt"]),
            )
        self.assertEqual(campaign["mode"], "auto_submit")

    def test_action_claim_rejects_mismatched_persisted_application_identity(self):
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        application_path = self.store._application_path(
            self.application_ref, lease["campaignId"]
        )
        application = json.loads(application_path.read_text(encoding="utf-8"))
        application["applicationRef"] = reference("application", "substituted")
        application_path.write_text(json.dumps(application), encoding="utf-8")
        activated = []

        with self.assertRaises(POLICY.PolicyError):
            self.store.claim_final_action(
                self.application_ref,
                lease["leaseId"],
                lease["attempt"],
                self.authorization(),
                CONFIRMATION_CAPABILITY,
                now=NOW,
                activation=lambda current: activated.append(current["claimId"]),
            )

        application["authorization"]["applicationRef"] = application["applicationRef"]
        application["authorizationFingerprint"] = POLICY._digest(
            POLICY._authorization(application["authorization"])
        )
        application_path.write_text(json.dumps(application), encoding="utf-8")
        with self.assertRaises(POLICY.PolicyError):
            self.store.claim_final_action(
                self.application_ref,
                lease["leaseId"],
                lease["attempt"],
                self.authorization(),
                CONFIRMATION_CAPABILITY,
                now=NOW,
                activation=lambda current: activated.append(current["claimId"]),
            )

        self.assertEqual(activated, [])

    def test_unclaimed_or_killed_attempt_cannot_record_outcome(self):
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        with self.assertRaises(POLICY.PolicyError):
            self.store.record_outcome(
                lease["campaignId"],
                self.application_ref,
                lease["leaseId"],
                reference("claim", "fabricated"),
                "uncertain",
                now=NOW,
            )

    def test_outcome_is_recorded_against_claiming_archived_campaign(self):
        original = self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        claim = self.claim(lease)
        self.store.revoke(now=NOW)
        replacement = self.store.activate(
            self.campaign_input(), now=NOW + timedelta(seconds=1)
        )

        receipt = self.store.record_outcome(
            claim["campaignId"],
            self.application_ref,
            lease["leaseId"],
            claim["claimId"],
            "uncertain",
            now=NOW + timedelta(seconds=1),
        )

        self.assertEqual(receipt["campaignId"], original["campaignId"])
        self.assertEqual(receipt["status"], "retry_available")
        archived_application = self.store._load_application(
            self.application_ref, original["campaignId"]
        )
        self.assertEqual(archived_application["status"], "retry_available")
        self.assertEqual(self.store.load_campaign(), replacement)

    def test_activation_callback_is_inside_policy_lock_and_exactly_once(self):
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        activated = []

        claim = self.store.claim_final_action(
            self.application_ref,
            lease["leaseId"],
            lease["attempt"],
            self.authorization(),
            CONFIRMATION_CAPABILITY,
            now=NOW,
            activation=lambda current: activated.append(current["claimId"]),
        )
        self.assertEqual(activated, [claim["claimId"]])
        with self.assertRaises(POLICY.PolicyError):
            self.store.claim_final_action(
                self.application_ref,
                lease["leaseId"],
                lease["attempt"],
                self.authorization(),
                CONFIRMATION_CAPABILITY,
                now=NOW,
                activation=lambda current: activated.append(current["claimId"]),
            )
        self.assertEqual(activated, [claim["claimId"]])

    def test_cli_is_inert_and_never_imports_browser_control(self):
        source = SCRIPT.read_text(encoding="utf-8").lower()
        for forbidden in ("playwright", "selenium", "browser.", "click(", "mcp__"):
            self.assertNotIn(forbidden, source)
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root), "status"],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(completed.stdout)["mode"], "review_only")


if __name__ == "__main__":
    unittest.main()
