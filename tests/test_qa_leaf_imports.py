import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class QALeafImportContractTests(unittest.TestCase):
    def test_contracts_facade_preserves_external_symbols(self):
        import qa.contracts as facade
        import qa.contracts_fixture as fixture
        import qa.contracts_model as model
        import qa.contracts_observation as observation

        expected = {
            "CAPTURE_MONTH": model.CAPTURE_MONTH,
            "CATALOG": model.CATALOG,
            "ContractError": model.ContractError,
            "FINAL_ACTION": model.FINAL_ACTION,
            "LEVER_CONTROL_PROFILE": model.LEVER_CONTROL_PROFILE,
            "READINESS_CONTROL_KIND_BY_ROLE": model.READINESS_CONTROL_KIND_BY_ROLE,
            "READINESS_SCHEMA_VERSION": model.READINESS_SCHEMA_VERSION,
            "SHA256": model.SHA256,
            "generic_control": fixture.generic_control,
            "validate_fixture": fixture.validate_fixture,
            "validate_readiness_observation": observation.validate_readiness_observation,
        }
        for name, value in expected.items():
            with self.subTest(name=name):
                self.assertIs(getattr(facade, name), value)

    def test_oracle_facade_preserves_external_symbols(self):
        import qa.oracle as facade
        import qa.oracle_io as oracle_io

        self.assertIs(facade.OracleError, oracle_io.OracleError)
        for name in (
            "MAX_HISTORY_LINES",
            "MAX_SESSION_ENTRIES",
            "_DESCRIPTOR_TRAVERSAL_AVAILABLE",
            "evaluate_form_readiness",
            "evaluate_run",
            "os",
        ):
            with self.subTest(name=name):
                self.assertTrue(hasattr(facade, name))

    def test_server_facade_preserves_external_symbols(self):
        import qa.server as facade
        import qa.server_auth as auth
        import qa.server_events as events
        import qa.server_final_action as final_action

        self.assertTrue(hasattr(facade, "MAX_EVENTS"))
        self.assertTrue(hasattr(facade, "ReplayHTTPServer"))
        self.assertTrue(callable(auth.authorize_post))
        self.assertTrue(callable(events.record_event))
        self.assertTrue(callable(final_action.handle_final_action))

    def test_recorder_facade_preserves_external_symbols(self):
        import qa.recorder_broker as broker
        import qa.recorder_fs as facade
        import qa.recorder_fs_ops as fs_ops
        import qa.recorder_guardian as guardian

        self.assertIs(facade.BrokerError, fs_ops.BrokerError)
        self.assertIs(facade.SessionBroker, broker.SessionBroker)
        for name in (
            "_EXCLUSIVE_RENAME",
            "_bounded_lines",
            "_exclusive_rename_raw",
            "exclusive_rename",
        ):
            with self.subTest(name=name):
                self.assertTrue(hasattr(facade, name))
        self.assertTrue(callable(fs_ops.exclusive_rename_available))
        self.assertIs(facade._bounded_lines, guardian._bounded_lines)

    def test_resume_onboarding_facade_preserves_scenario_types(self):
        import qa.resume_extraction_companion as companion
        import qa.resume_extraction_scenario as scenario

        facade = load(
            "resume_extraction_onboarding_import_contract",
            ROOT / "qa" / "resume_extraction_onboarding_oracle.py",
        )
        self.assertIs(facade.Companion, companion.Companion)
        self.assertIs(facade.Oracle, scenario.Oracle)

    def test_account_facade_preserves_walkthrough_entry_points(self):
        import qa.account_environment as environment
        import qa.account_walkthrough as walkthrough

        facade = load(
            "qa_account_import_contract", ROOT / "scripts" / "qa-account.py"
        )
        self.assertIs(facade._compile_native, environment._compile_native)
        self.assertIs(facade._workday_scenario_result, walkthrough._workday_scenario_result)
        self.assertIs(facade.verify_all, walkthrough.verify_all)
        self.assertIs(facade.verify_oracle_email_only, walkthrough.verify_oracle_email_only)


if __name__ == "__main__":
    unittest.main()
