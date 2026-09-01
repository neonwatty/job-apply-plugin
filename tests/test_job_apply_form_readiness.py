import copy
import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "job_apply_form_readiness_test",
    ROOT / "scripts" / "job_apply_form_readiness.py",
)
READINESS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(READINESS)
FIXTURE_PATH = (
    ROOT / "qa" / "fixtures" / "greenhouse-form-readiness-v1" / "fixture.json"
)


class FormReadinessTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        self.states = {
            "contact.first_name": "complete",
            "contact.phone_country": "complete",
            "resume.file": "accepted",
            "authorization.sponsorship_select": "complete",
        }

    def observation(self, **overrides):
        states = overrides.pop("control_states", self.states)
        return READINESS.make_readiness_observation(
            self.fixture,
            states,
            observation_revision=overrides.pop("observation_revision", 7),
            **overrides,
        )

    def evaluate(self, observation=None, expected_revision=7):
        return READINESS.evaluate_readiness(
            self.fixture,
            observation or self.observation(),
            expected_observation_revision=expected_revision,
        )

    def test_complete_greenhouse_observation_is_ready_and_value_free(self):
        report = self.evaluate(
            self.observation(upload_capability="external-runtime-unavailable")
        )
        self.assertEqual(
            set(report),
            {
                "schemaVersion",
                "proofScope",
                "status",
                "platformFamily",
                "observationRevision",
                "assertions",
                "unresolvedControlIds",
                "blockerCodes",
                "fallbackCode",
            },
        )
        self.assertEqual(report["proofScope"], "repository-replay-only")
        self.assertEqual(report["status"], "ready")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["unresolvedControlIds"], [])
        self.assertEqual(report["blockerCodes"], [])
        self.assertIsNone(report["fallbackCode"])
        serialized = json.dumps(report)
        for forbidden in ("filename", "filepath", "https://", "browser", "value"):
            self.assertNotIn(forbidden, serialized.lower())

    def test_optional_control_may_be_absent(self):
        self.assertEqual(self.evaluate()["status"], "ready")

    def test_missing_required_control_fails_closed(self):
        states = dict(self.states)
        del states["contact.first_name"]
        report = self.evaluate(self.observation(control_states=states))
        self.assertEqual(report["status"], "blocked")
        self.assertIn(
            "required-control-evidence-missing", report["blockerCodes"]
        )
        self.assertEqual(report["unresolvedControlIds"], ["contact.first_name"])

    def test_each_non_success_required_state_blocks(self):
        cases = (
            ("contact.first_name", "missing", "required-control-incomplete"),
            ("contact.first_name", "rejected", "required-control-rejected"),
            ("contact.first_name", "unresolved", "required-control-unresolved"),
            ("contact.first_name", "inaccessible", "required-control-inaccessible"),
            ("resume.file", "rejected", "required-upload-rejected"),
            ("resume.file", "unresolved", "required-control-unresolved"),
            ("resume.file", "inaccessible", "required-control-inaccessible"),
        )
        for control_id, state, blocker in cases:
            with self.subTest(control_id=control_id, state=state):
                states = dict(self.states)
                states[control_id] = state
                report = self.evaluate(self.observation(control_states=states))
                self.assertEqual(report["status"], "blocked")
                self.assertIn(blocker, report["blockerCodes"])
                self.assertIn(control_id, report["unresolvedControlIds"])

    def test_external_upload_failure_has_bounded_owner_fallback(self):
        states = dict(self.states)
        states["resume.file"] = "missing"
        report = self.evaluate(
            self.observation(
                control_states=states,
                upload_capability="external-runtime-unavailable",
            )
        )
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["fallbackCode"], "owner-upload-required")
        self.assertIn("required-upload-missing", report["blockerCodes"])
        self.assertIn(
            "external-upload-capability-unavailable", report["blockerCodes"]
        )

    def test_stale_top_level_or_control_evidence_blocks(self):
        stale_top = self.evaluate(expected_revision=8)
        self.assertEqual(stale_top["status"], "blocked")
        self.assertIn("readiness-evidence-stale", stale_top["blockerCodes"])

        observation = self.observation()
        observation["controls"][0]["observationRevision"] = 6
        stale_control = self.evaluate(observation)
        self.assertEqual(stale_control["status"], "blocked")
        self.assertIn("readiness-evidence-stale", stale_control["blockerCodes"])
        self.assertIn(
            observation["controls"][0]["controlId"],
            stale_control["unresolvedControlIds"],
        )

    def test_inaccessible_adapter_and_hidden_validation_error_block(self):
        inaccessible = self.evaluate(
            self.observation(adapter_state="inaccessible")
        )
        self.assertEqual(inaccessible["status"], "blocked")
        self.assertIn("form-observation-inaccessible", inaccessible["blockerCodes"])

        invalid = self.evaluate(
            self.observation(
                validation_error_control_ids=["contact.phone_country"]
            )
        )
        self.assertEqual(invalid["status"], "blocked")
        self.assertIn("validation-error-present", invalid["blockerCodes"])
        self.assertIn("contact.phone_country", invalid["unresolvedControlIds"])

    def test_final_control_must_be_available_and_never_activated(self):
        cases = (
            ("unavailable", "final-control-unavailable"),
            ("inaccessible", "final-control-inaccessible"),
            ("activated", "final-action-activated"),
        )
        for state, blocker in cases:
            with self.subTest(state=state):
                report = self.evaluate(
                    self.observation(final_control_state=state)
                )
                self.assertEqual(report["status"], "blocked")
                self.assertIn(blocker, report["blockerCodes"])
                if state == "activated":
                    self.assertEqual(
                        report["assertions"]["final-action-untouched"], "failed"
                    )

    def test_contract_rejects_unknown_value_bearing_or_malformed_evidence(self):
        observation = self.observation()
        cases = []
        with_value = copy.deepcopy(observation)
        with_value["controls"][0]["value"] = "PRIVATE"
        cases.append(with_value)
        unknown = copy.deepcopy(observation)
        unknown["controls"][0]["controlId"] = "unknown.private"
        cases.append(unknown)
        wrong_kind = copy.deepcopy(observation)
        wrong_kind["controls"][0]["kind"] = "upload"
        cases.append(wrong_kind)
        duplicate = copy.deepcopy(observation)
        duplicate["controls"].append(copy.deepcopy(duplicate["controls"][0]))
        cases.append(duplicate)
        invalid_revision = copy.deepcopy(observation)
        invalid_revision["observationRevision"] = True
        cases.append(invalid_revision)

        for candidate in cases:
            with self.subTest(candidate=candidate):
                with self.assertRaisesRegex(
                    READINESS.FormReadinessError,
                    "^invalid readiness observation$",
                ) as raised:
                    self.evaluate(candidate)
                self.assertNotIn("PRIVATE", str(raised.exception))

    def test_builder_rejects_unknown_controls_without_echoing_identity(self):
        with self.assertRaisesRegex(
            READINESS.FormReadinessError,
            "^invalid readiness control states$",
        ):
            self.observation(control_states={"unknown.private": "complete"})


if __name__ == "__main__":
    unittest.main()
