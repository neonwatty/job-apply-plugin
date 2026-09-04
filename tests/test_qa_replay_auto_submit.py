from tests.support.pdf_fixture import *
from tests.support.replay_case import *


class ReplayCoordinatorTests(ReplayCase):
    def test_skills_document_mandatory_qa_root_routing(self) -> None:
        answer_memory = (ROOT / "skills/answer-memory/SKILL.md").read_text()
        job_apply = (ROOT / "skills/job-apply/SKILL.md").read_text()
        for document in (answer_memory, job_apply):
            self.assertIn("qa-replay.py", document)
            self.assertIn("--route-token", document)
            self.assertIn("--root", document)
            self.assertIn("before", document.lower())
            self.assertIn("#qa-route=<run-id>.<64-lowercase-hex-token>", document)
            self.assertIn("cleanup --run-id", document)
            self.assertIn("report", document.lower())
            self.assertIn("sanitized tombstone", document.lower())
            self.assertIn("never unlinks", document.lower())
        coordinator = SCRIPT.read_text()
        self.assertNotIn("os.kill(", coordinator)
        self.assertNotIn('["ps",', coordinator)

    def test_verify_auto_submit_is_repeatable_redacted_and_loopback_only(self):
        fixture = ROOT / "qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json"
        for _ in range(2):
            completed = __import__("subprocess").run(
                [
                    "python3",
                    str(SCRIPT),
                    "verify-auto-submit",
                    "--fixture",
                    str(fixture),
                    "--json",
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(completed.stdout)
            self.assertEqual(report["status"], "passed")
            self.assertIs(report["redacted"], True)
            self.assertEqual(
                set(report["assertions"]),
                {
                    "actual-review-only-refused",
                    "all-stop-boundaries-zero-activations",
                    "concurrent-activation-single-winner",
                    "danger-warning-required",
                    "denials-and-receipts-redacted",
                    "forged-stale-prompt-redirect-kill-expiry-refused",
                    "independent-confirmation-required",
                    "kill-versus-activation-linearized",
                    "one-retry-terminal-exhaustion",
                    "review-only-zero-activations",
                    "success-one-claimed-activation",
                },
            )
            self.assertEqual(set(report["assertions"].values()), {"passed"})
            self.assertEqual(
                report["scenarios"]["success"]["claimedActivations"], 1
            )
            self.assertEqual(
                report["scenarios"]["uncertainty-retry"]["terminalState"],
                "uncertain_exhausted",
            )
            serialized = completed.stdout.casefold()
            for forbidden in ("http://", "https://", "answerrevision", "resume-v1"):
                self.assertNotIn(forbidden, serialized)
