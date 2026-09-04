from __future__ import annotations

import argparse
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

from tests.support.replay_case import load_cli


LEGACY_STAR_EXPORTS = {
    "ASSERTION_NAMES",
    "Any",
    "BrokerError",
    "ContractError",
    "CoordinatorError",
    "EXPECTED_KEYS",
    "FAILURE_CATEGORIES",
    "FIXTURES_ROOT",
    "IDENTIFIER",
    "MARKER_TEMP",
    "MAX_CLEANUP_BYTES",
    "MAX_CLEANUP_DEPTH",
    "MAX_CLEANUP_ENTRIES",
    "MAX_JSON_BYTES",
    "MAX_RESUME_BYTES",
    "OracleError",
    "PLATFORM_LABELS",
    "PROMPT",
    "Path",
    "PolicyError",
    "PolicyStore",
    "REPORT_KEYS",
    "REPO_ROOT",
    "REQUEST_TIMEOUT_SECONDS",
    "ROUTE",
    "RUNS_ROOT",
    "RUN_ID",
    "RUN_STATE_KEYS",
    "ReplayHTTPServer",
    "SCENARIOS_ROOT",
    "SCENARIO_IDS",
    "STARTUP_TIMEOUT_SECONDS",
    "STORE_SCRIPT",
    "TOKEN",
    "TOMBSTONE_KEYS",
    "ThreadPoolExecutor",
    "annotations",
    "argparse",
    "build_parser",
    "confirmation_authority_revision",
    "datetime",
    "evaluate_run",
    "exclusive_rename",
    "fcntl",
    "hashlib",
    "hmac",
    "json",
    "main",
    "os",
    "queue",
    "re",
    "secrets",
    "stat",
    "subprocess",
    "sys",
    "tempfile",
    "threading",
    "timedelta",
    "timezone",
    "urllib",
    "urlsplit",
    "validate_fixture",
}


class ReplayFacadeContractTests(unittest.TestCase):
    def test_facade_freezes_legacy_star_import_inventory(self) -> None:
        facade = load_cli()

        self.assertEqual(set(facade.__all__), LEGACY_STAR_EXPORTS)
        self.assertTrue(all(hasattr(facade, name) for name in facade.__all__))

    def test_package_has_small_public_surface_and_shared_error_identity(self) -> None:
        facade = load_cli()
        import qa.replay as package

        self.assertEqual(
            set(package.__all__),
            {
                "CoordinatorError",
                "cleanup",
                "evaluate",
                "main",
                "prepare",
                "record_transition",
                "resolve_route",
                "verify_auto_submit",
            },
        )
        self.assertIs(package.CoordinatorError, facade.CoordinatorError)

    def test_importing_leaf_does_not_import_hyphenated_facade(self) -> None:
        command = (
            "import sys; import qa.replay.cleanup; "
            "assert 'qa_replay_cli' not in sys.modules"
        )
        result = subprocess.run(
            [sys.executable, "-c", command],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_split_cli_dispatches_through_supplied_runtime(self) -> None:
        from qa.replay import cli

        parser = mock.Mock()
        parser.parse_args.return_value = argparse.Namespace(
            command="cleanup", run_id="qa-run-20260904-deadbeef"
        )
        calls: list[str] = []
        runtime = SimpleNamespace(
            CoordinatorError=cli.CoordinatorError,
            build_parser=lambda: parser,
            _cleanup=lambda run_id: (
                calls.append(run_id)
                or {
                    "runId": run_id,
                    "state": "abandoned",
                    "reportRetained": False,
                }
            ),
            json=json,
            sys=SimpleNamespace(stderr=io.StringIO()),
        )
        stdout = io.StringIO()

        with contextlib.redirect_stdout(stdout):
            code = cli.main([], _runtime=runtime)

        self.assertEqual(code, 0)
        self.assertEqual(calls, ["qa-run-20260904-deadbeef"])
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {
                "runId": "qa-run-20260904-deadbeef",
                "state": "abandoned",
                "reportRetained": False,
            },
        )

    def test_facade_cli_keeps_legacy_function_patch_points(self) -> None:
        facade = load_cli()
        parser = mock.Mock()
        parser.parse_args.return_value = argparse.Namespace(
            command="prepare", fixture="fixture-v1", scenario="complete-profile"
        )
        result = {
            "fixtureId": "fixture-v1",
            "scenarioId": "complete-profile",
            "url": "http://127.0.0.1:1234#qa-route=opaque",
            "storeRoot": "/tmp/store",
            "suggestedPrompt": "prompt",
        }
        stdout = io.StringIO()

        with (
            mock.patch.object(facade, "build_parser", return_value=parser),
            mock.patch.object(facade, "_prepare", return_value=result) as prepare,
            contextlib.redirect_stdout(stdout),
        ):
            self.assertEqual(facade.main([]), 0)

        prepare.assert_called_once_with("fixture-v1", "complete-profile")
        self.assertEqual(json.loads(stdout.getvalue()), result)

    def test_facade_keeps_nested_server_patch_points(self) -> None:
        facade = load_cli()
        state = {
            "url": "http://127.0.0.1:1234",
            "shutdownToken": "0" * 64,
        }

        with (
            mock.patch.object(facade, "_verify_identity") as verify,
            mock.patch.object(facade, "_shutdown_server") as shutdown,
        ):
            facade._shutdown_authenticated_run(state)

        verify.assert_called_once_with(state)
        shutdown.assert_called_once_with(
            state["url"], state["shutdownToken"], required=True
        )


if __name__ == "__main__":
    unittest.main()
