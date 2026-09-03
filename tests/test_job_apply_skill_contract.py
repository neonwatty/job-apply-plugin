import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_PATH = ROOT / "skills" / "job-apply" / "SKILL.md"
WORKSPACE_SKILL_PATH = ROOT / "skills" / "job-workspace" / "SKILL.md"
README_PATH = ROOT / "README.md"


class JobApplySkillContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = SKILL_PATH.read_text(encoding="utf-8")
        cls.workspace_skill = WORKSPACE_SKILL_PATH.read_text(encoding="utf-8")
        cls.readme = README_PATH.read_text(encoding="utf-8")
        cls.normalized = " ".join(cls.skill.split())

    def test_action_time_consent_requires_visible_readiness(self):
        self.assertIn("Post-readiness action-time consent", self.skill)
        self.assertIn("Before the exact application form is visibly ready", self.skill)
        self.assertIn("blanket future consent are invalid", self.skill)
        self.assertIn("current message was sent after that visible readiness", self.skill)

    def test_matching_consent_is_consumed_once_without_duplicate_confirmation(self):
        self.assertIn("transitions once to `consent_consumed`", self.skill)
        self.assertIn("Proceed without asking for the same confirmation again", self.skill)
        self.assertIn("It is not reusable for another job", self.skill)
        self.assertIn("must not trigger duplicate confirmation", self.skill)

    def test_only_material_scope_destination_or_purpose_change_reconfirms(self):
        self.assertIn(
            "A material change to the data scope, destination, or purpose invalidates the consumed consent",
            self.skill,
        )
        self.assertIn("obtain new explicit post-change consent", self.skill)
        self.assertIn("Ordinary page progression within the unchanged bounds", self.skill)

    def test_user_facing_summaries_are_value_free(self):
        self.assertIn("Never echo raw applicant values", self.skill)
        self.assertIn("Describe only field names or groups, counts, and states", self.skill)
        for unsafe in (
            "Summarize every entered value",
            "summarize all entered fields",
            "summarize the fields",
            "Review the parsed and entered values",
            "summarize the application for the user",
        ):
            self.assertNotIn(unsafe, self.skill)

    def test_attempt_helper_surface_remains_closed(self):
        invocations = re.findall(
            r"job-apply-attempt\.py[^`\n]*?\s(start|heartbeat|progress|handoff)(?:\s|`)",
            self.skill,
        )
        self.assertTrue(invocations)
        self.assertEqual(set(invocations), {"start", "heartbeat", "progress", "handoff"})
        for forbidden in (" stop", " abort", " release", " recover", " adopt"):
            self.assertNotRegex(self.skill, rf"job-apply-attempt\.py[^`\n]*{forbidden}\b")

    def test_readme_documents_detached_broker_not_attached_stdin_process(self):
        for required in (
            "detached broker scoped to one Store and exact selected attempt",
            "later stateless `heartbeat`, value-free `progress`, and `handoff` clients",
            "`needs_info` handoff so the broker releases the claim and exits",
            "exact job, session, and answer revisions shown there",
            "fresh broker acquisition for the same canonical job",
        ):
            self.assertIn(required, self.readme)

        for stale in (
            "lifetime of one attached process",
            "accepts only value-free progress and `needs_info` or `awaiting_review` handoff messages on stdin",
            "Start a new private attempt process",
        ):
            self.assertNotIn(stale, self.readme)

    def test_field_entry_requires_observed_persistence(self) -> None:
        self.assertIn("attempted write, not proof", self.normalized)
        self.assertIn("immediately read the control's current state", self.normalized)
        self.assertIn("compare it privately with the intended value", self.normalized)
        self.assertIn("merely because the browser operation returned no error", self.normalized)

    def test_field_entry_recovery_is_bounded_and_rerender_safe(self) -> None:
        self.assertIn("at most one safe", self.normalized)
        self.assertIn("Do not repeat the same", self.normalized)
        self.assertIn("Revalidate already-filled critical controls", self.normalized)
        self.assertIn("Restore a cleared value at most once", self.normalized)

    def test_failed_entry_is_not_misclassified_as_missing_data(self) -> None:
        self.assertIn("do not ask the user for it again", self.normalized)
        self.assertIn("`unsupported-control` with `owner-input-required`", self.normalized)
        self.assertIn("browser handoff, not a missing-answer request", self.normalized)
        self.assertIn("Browser action required", self.skill)
        self.assertIn("already known", self.normalized)

    def test_form_instances_and_consent_remain_separate(self) -> None:
        self.assertIn("independent forms", self.normalized)
        self.assertIn("requires fresh consent", self.normalized)
        self.assertIn("Keep every final action untouched throughout recovery", self.normalized)

    def test_resume_extraction_discovery_is_context_bounded(self) -> None:
        self.assertIn("resume-extraction-request-list --status requested", self.skill)
        self.assertIn("when the owner asks about resumes, facts, or onboarding", self.skill)
        self.assertIn("when given an exact extraction request ID", self.skill)
        self.assertIn("Never scan for extraction requests during every job application", self.skill)

    def test_resume_extraction_fulfills_one_exact_request_privately(self) -> None:
        for required in (
            "resume-extraction-request-get --id <request-id>",
            "resume-resolve --id <resume-id>",
            "profile-inspect",
            "resume-proposal-list --resume-id <resume-id>",
            "resume-extraction-request-complete",
            "--expected-pending-proposal-id <proposal-id>",
            "delete the permission-restricted candidate file",
            "Do not retry",
            "Stop at proposal review",
        ):
            self.assertIn(required, self.skill)
        self.assertIn("complete the exact request once", self.skill)

    def test_resume_extraction_failure_reasons_are_closed(self) -> None:
        self.assertIn("resume-extraction-request-fail", self.skill)
        for reason in (
            "content_unreadable",
            "unsupported_resume",
            "extraction_failed",
            "candidate_invalid",
            "interrupted",
        ):
            self.assertIn(f"`{reason}`", self.skill)

    def test_workspace_queues_but_does_not_perform_extraction(self) -> None:
        for required in (
            "create, cancel, and retry extraction requests",
            "queues work for the next active Job Apply agent",
            "does not start or launch an agent",
            "cannot extract facts, complete or fail a request, or author a proposal",
        ):
            self.assertIn(required, self.workspace_skill)
            self.assertIn(required, self.readme)
        self.assertNotIn("the workspace extracts", self.workspace_skill.lower())


if __name__ == "__main__":
    unittest.main()
