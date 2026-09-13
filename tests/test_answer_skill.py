from scripts.skill_documents import skill_text
from tests.support.answer_cli_case import *


class AnswerMemoryIntegrationTests(AnswerCliCase):
    def test_skills_share_one_helper_contract_and_manual_submit_boundary(self):
        skills = {
            path.parent.name: skill_text(path)
            for path in (ROOT / "skills").glob("*/SKILL.md")
        }
        self.assertEqual(
            set(skills),
            {
                "answer-memory",
                "job-apply",
                "job-preferences",
                "job-search",
                "job-workspace",
            },
        )
        for name in ("answer-memory", "job-apply", "job-preferences", "job-search"):
            self.assertIn("job-apply-store.py", skills[name], name)
        self.assertIn("job-apply-workspace.py", skills["job-workspace"])
        self.assertIn("canonical Store contract", skills["job-workspace"])
        for name in ("job-apply", "job-preferences", "job-search"):
            self.assertNotIn("Read `~/.claude-job-profile.json`", skills[name])
            self.assertNotIn("Write the collected values into `~/.claude-job-profile.json`", skills[name])
        self.assertIn("--remember-sensitive", skills["answer-memory"])
        self.assertIn("Permission to fill is not permission to remember", skills["answer-memory"])
        self.assertIn(
            "User confirmation never authorizes this skill to click Submit",
            skills["job-apply"],
        )
        self.assertIn("review_only", skills["job-apply"])
        self.assertIn("job_apply_policy.py", skills["job-apply"])
        self.assertIn("atomically claims one final action", skills["job-apply"])

        storage_contract = (
            ROOT / "skills/answer-memory/references/storage-contract.md"
        ).read_text()
        self.assertIn("sole existing-record exception to expected-revision input", storage_contract)
        self.assertIn("only the dedicated review operation", storage_contract)
        self.assertIn("Greenhouse, LinkedIn Easy Apply, Ashby, and Lever", storage_contract)
        self.assertIn("isolated loopback QA adapter", skills["job-apply"])
        self.assertIn("Every live Submit", skills["job-apply"])
        self.assertIn("separately audited canary", skills["job-apply"])
        self.assertIn("Auto-submit policy", skills["answer-memory"])
        self.assertIn("job-list --status ready", skills["job-apply"])
        self.assertIn("job-acquire", skills["job-apply"])
        self.assertIn("job-apply-attempt.py", skills["job-apply"])
        self.assertIn("Never fall back to raw `claim-handoff`", skills["job-apply"])
        self.assertIn("--status awaiting_review", skills["job-apply"])
        self.assertIn("--input <private-temp.json>", skills["job-apply"])
        self.assertIn("agent_attested_current_attempt", skills["job-apply"])
        self.assertIn("If the user supplied a job URL", skills["job-apply"])
        self.assertIn("User confirmation never authorizes this skill to click Submit", skills["job-apply"])
