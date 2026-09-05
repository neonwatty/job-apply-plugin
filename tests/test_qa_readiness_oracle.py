from tests.support.oracle_fixtures import *
from tests.support.running_replay_server import *


class FormReadinessOracleTests(FormReadinessOracleCase):
    def test_readiness_oracle_returns_only_closed_replay_evidence(self):
        observation = make_readiness_observation(
            self.fixture,
            self.states,
            observation_revision=4,
            upload_capability="external-runtime-unavailable",
        )
        report = evaluate_form_readiness(
            self.fixture,
            observation,
            expected_observation_revision=4,
        )
        self.assertEqual(report["status"], "ready")
        self.assertEqual(report["proofScope"], "closed-observation-only")
        self.assertEqual(report["blockerCodes"], [])
        serialized = json.dumps(report).lower()
        for forbidden in ("filename", "filepath", "https://", "browser", "value"):
            self.assertNotIn(forbidden, serialized)

    def test_readiness_oracle_preserves_value_free_failure_categories(self):
        states = dict(self.states)
        states["resume.file"] = "missing"
        observation = make_readiness_observation(
            self.fixture,
            states,
            observation_revision=4,
            upload_capability="external-runtime-unavailable",
        )
        report = evaluate_form_readiness(
            self.fixture,
            observation,
            expected_observation_revision=4,
        )
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["fallbackCode"], "owner-upload-required")
        self.assertIn("required-upload-missing", report["blockerCodes"])

    def test_readiness_oracle_closes_malformed_diagnostics(self):
        observation = make_readiness_observation(
            self.fixture,
            self.states,
            observation_revision=4,
        )
        observation["privateValue"] = "ORACLE SECRET"
        with self.assertRaisesRegex(
            OracleError, "^invalid form readiness evidence$"
        ) as raised:
            evaluate_form_readiness(
                self.fixture,
                observation,
                expected_observation_revision=4,
            )
        self.assertNotIn("ORACLE SECRET", str(raised.exception))
