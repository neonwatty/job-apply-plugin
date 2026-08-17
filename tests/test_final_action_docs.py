import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECKER_PATH = ROOT / "scripts" / "check-final-action-docs.py"
SPEC = importlib.util.spec_from_file_location("check_final_action_docs", CHECKER_PATH)
CHECKER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CHECKER)


class FinalActionDocumentationTests(unittest.TestCase):
    def assertAccepted(self, text):
        self.assertEqual(CHECKER.violations_for_text(text), [])

    def assertRejected(self, text):
        self.assertTrue(CHECKER.violations_for_text(text), text)

    def test_committed_job_apply_policy_is_accepted(self):
        skill = (ROOT / "skills" / "job-apply" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertAccepted(skill)

    def test_safe_policy_heading_and_blocking_prose_are_accepted(self):
        self.assertAccepted(
            "## Auto-submit policy boundary\n\n"
            "Every live Submit, Send, Apply, or equivalent final action remains blocked.\n"
            "Stop before the final action and leave the Submit button untouched.\n"
            "The user submits the application manually.\n"
        )

    def test_exact_easy_apply_entry_controls_are_accepted(self):
        for instruction in (
            "Click Easy Apply button to open the modal.",
            'Click "Easy Apply" button to open the application modal.',
            "Click 'Easy Apply' link to open the application form.",
            "Click `Easy Apply` button for opening the application form.",
        ):
            with self.subTest(instruction=instruction):
                self.assertAccepted(instruction)

    def test_unguarded_direct_final_actions_are_rejected(self):
        for instruction in (
            "Click Submit application.",
            "Click Apply button.",
            'Click "Apply" button to open the application form.',
            'Click "Quick Apply" button to open the application form.',
            'Click "Easy Apply" button.',
            'Click "Easy Apply" button to inspect the page.',
            "Click 'Easy Apply\" button to open the application form.",
            "Activate the final-action control.",
            "Submit the application.",
            "Send the application now.",
            "Apply now.",
            "Apply automatically.",
            "Click the final-action control.",
            "The assistant should click the Submit button.",
            "The automation submits the application automatically.",
        ):
            with self.subTest(instruction=instruction):
                self.assertRejected(instruction)

    def test_policy_heading_does_not_exempt_unsafe_instruction(self):
        self.assertRejected(
            "## Auto-submit policy boundary\n\nClick Submit application.\n"
        )

    def test_unsafe_heading_is_rejected(self):
        self.assertRejected("## Submit applications automatically\n")

    def test_unrelated_safety_words_do_not_exempt_actionable_clauses(self):
        for instruction in (
            "Do not wait; click Submit application.",
            "Click Submit application; do not ask again.",
            "Never hesitate; click Apply button.",
            "Do not wait, click Submit application.",
            "Click Submit application, but do not ask again.",
            "Apply now, do not ask again.",
            "Click this control; the control is labeled Apply button.",
            "Activate this control; it is the final-action control.",
            "Click this control; it is the Submit button; do not wait.",
        ):
            with self.subTest(instruction=instruction):
                self.assertRejected(instruction)

        for instruction in (
            "Do not click Submit application.",
            "Stop before the final action and leave the Submit button untouched.",
            "The user submits the application manually.",
            "Do not click this control; it is the Submit button.",
        ):
            with self.subTest(instruction=instruction):
                self.assertAccepted(instruction)


if __name__ == "__main__":
    unittest.main()
