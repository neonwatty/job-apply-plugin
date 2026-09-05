from __future__ import annotations

import argparse
import contextlib
import inspect
import io
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

from tests.support.replay_case import (
    FIXTURE_ID,
    SCENARIO_ID,
    ReplayCase,
    load_cli,
)


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


LEGACY_HELPER_CONTRACTS = {
    "_atomic_json_at": (
        "(directory_descriptor: 'int', name: 'str', "
        "value: 'dict[str, Any]') -> 'None'",
        {
            "directory_descriptor": "int",
            "name": "str",
            "value": "dict[str, Any]",
            "return": "None",
        },
    ),
    "_ensure_marker_at": (
        "(directory_descriptor: 'int', name: 'str', "
        "value: 'dict[str, Any]') -> 'None'",
        {
            "directory_descriptor": "int",
            "name": "str",
            "value": "dict[str, Any]",
            "return": "None",
        },
    ),
    "_entry_exists_at": (
        "(directory_descriptor: 'int', name: 'str') -> 'bool'",
        {
            "directory_descriptor": "int",
            "name": "str",
            "return": "bool",
        },
    ),
    "_opaque": (
        "(kind: 'str', label: 'str') -> 'str'",
        {"kind": "str", "label": "str", "return": "str"},
    ),
    "_open_private_directory": (
        "(path: 'Path', diagnostic: 'str') -> 'int'",
        {"path": "Path", "diagnostic": "str", "return": "int"},
    ),
    "_post_claimed_action": (
        "(base_url: 'str', token: 'str', lease: 'dict[str, Any]', "
        "authorization: 'dict[str, Any]', step_id: 'str', "
        "safety_checks: 'dict[str, bool] | None' = None) -> "
        "'tuple[int, dict[str, Any]]'",
        {
            "base_url": "str",
            "token": "str",
            "lease": "dict[str, Any]",
            "authorization": "dict[str, Any]",
            "step_id": "str",
            "safety_checks": "dict[str, bool] | None",
            "return": "tuple[int, dict[str, Any]]",
        },
    ),
    "_publish_marker_at": (
        "(directory_descriptor: 'int', name: 'str', "
        "value: 'dict[str, Any]') -> 'None'",
        {
            "directory_descriptor": "int",
            "name": "str",
            "value": "dict[str, Any]",
            "return": "None",
        },
    ),
    "_read_json_at": (
        "(directory_descriptor: 'int', name: 'str', "
        "diagnostic: 'str') -> 'Any'",
        {
            "directory_descriptor": "int",
            "name": "str",
            "diagnostic": "str",
            "return": "Any",
        },
    ),
    "_read_regular_at": (
        "(directory_descriptor: 'int', name: 'str', limit: 'int', "
        "diagnostic: 'str') -> 'bytes'",
        {
            "directory_descriptor": "int",
            "name": "str",
            "limit": "int",
            "diagnostic": "str",
            "return": "bytes",
        },
    ),
    "_recover_signed_tombstone": (
        "(run_descriptor: 'int', run_id: 'str', state: 'dict[str, Any]', "
        "observed: 'Any') -> 'tuple[dict[str, Any], dict[str, Any]] | None'",
        {
            "run_descriptor": "int",
            "run_id": "str",
            "state": "dict[str, Any]",
            "observed": "Any",
            "return": "tuple[dict[str, Any], dict[str, Any]] | None",
        },
    ),
    "_report_digest": (
        "(report: 'dict[str, Any]') -> 'str'",
        {"report": "dict[str, Any]", "return": "str"},
    ),
    "_revision": (
        "(label: 'str') -> 'str'",
        {"label": "str", "return": "str"},
    ),
    "_signed_tombstone": (
        "(run_id: 'str', state: 'dict[str, Any]', cleanup_state: 'str', "
        "retain_report: 'bool', report: 'dict[str, Any] | None') -> "
        "'dict[str, Any]'",
        {
            "run_id": "str",
            "state": "dict[str, Any]",
            "cleanup_state": "str",
            "retain_report": "bool",
            "report": "dict[str, Any] | None",
            "return": "dict[str, Any]",
        },
    ),
    "_signed_tombstone_matches": (
        "(observed: 'Any', expected: 'dict[str, Any]') -> 'bool'",
        {
            "observed": "Any",
            "expected": "dict[str, Any]",
            "return": "bool",
        },
    ),
    "_validate_report": (
        "(report: 'Any', state: 'dict[str, Any]', "
        "fixture: 'dict[str, Any]') -> 'dict[str, Any]'",
        {
            "report": "Any",
            "state": "dict[str, Any]",
            "fixture": "dict[str, Any]",
            "return": "dict[str, Any]",
        },
    ),
    "_verify_directory_binding": (
        "(path: 'Path', descriptor: 'int', diagnostic: 'str') -> 'None'",
        {
            "path": "Path",
            "descriptor": "int",
            "diagnostic": "str",
            "return": "None",
        },
    ),
}


INVARIANT_COMMENT_BLOCKS = {
    "qa/replay/auto_submit.py": (
        "# The endpoint itself, not a detached claim proof, must consult the\n"
        "            # current store.  Missing/review-only policy therefore cannot act.",
        "# Exercise stale/forged/prompt/redirect/kill at the HTTP activation\n"
        "            # boundary with a fresh persisted lease for every independent case.",
    ),
    "qa/replay/server_control.py": (
        "# The server intentionally outlives this command. Mark this local handle as\n"
        "        # detached so Popen's destructor does not report the expected live child.",
    ),
    "qa/replay/cleanup.py": (
        "# A prepared run has no durable evidence that its detached server was\n"
        "            # already stopped. Preserve the shutdown capability on any transient\n"
        "            # failure so cleanup can be retried instead of orphaning the server.",
    ),
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

    def test_legacy_helper_metadata_matches_the_monolith_contract(self) -> None:
        facade = load_cli()

        for name, (signature, annotations) in LEGACY_HELPER_CONTRACTS.items():
            with self.subTest(name=name):
                helper = getattr(facade, name)
                self.assertEqual(str(inspect.signature(helper)), signature)
                self.assertEqual(helper.__name__, name)
                self.assertEqual(helper.__module__, "qa_replay_cli")
                self.assertEqual(helper.__annotations__, annotations)

    def test_extracted_leaves_retain_all_nine_invariant_comment_lines(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]

        for relative_path, blocks in INVARIANT_COMMENT_BLOCKS.items():
            source = (repository_root / relative_path).read_text()
            with self.subTest(path=relative_path):
                for block in blocks:
                    self.assertIn(block, source)


class ReplayLegacyOrchestrationSeamTests(ReplayCase):
    def test_prepare_dispatches_through_legacy_new_run_directory_seam(self) -> None:
        failure = self.cli.CoordinatorError("new-run seam reached")

        with mock.patch.object(
            self.cli, "_new_run_directory", side_effect=failure
        ) as new_run:
            with self.assertRaisesRegex(
                self.cli.CoordinatorError, "new-run seam reached"
            ):
                self.cli._prepare(FIXTURE_ID, SCENARIO_ID)

        new_run.assert_called_once_with()

    def test_route_dispatches_through_legacy_load_run_seam(self) -> None:
        run_id = "qa-run-20260904-deadbeef"
        failure = self.cli.CoordinatorError("load-run seam reached")

        with mock.patch.object(
            self.cli, "_load_run", side_effect=failure
        ) as load_run:
            with self.assertRaisesRegex(
                self.cli.CoordinatorError, "unknown QA route"
            ):
                self.cli._resolve_route(f"{run_id}.{'a' * 64}")

        load_run.assert_called_once_with(run_id)

    def test_lifecycle_dispatches_through_legacy_load_run_seam(self) -> None:
        run_id = "qa-run-20260904-deadbeef"
        failure = self.cli.CoordinatorError("load-run seam reached")

        with mock.patch.object(
            self.cli, "_load_run", side_effect=failure
        ) as load_run:
            with self.assertRaisesRegex(
                self.cli.CoordinatorError, "load-run seam reached"
            ):
                self.cli._record_transition(run_id, "started")

        load_run.assert_called_once_with(run_id)

    def test_evaluate_dispatches_through_legacy_load_run_seam(self) -> None:
        run_id = "qa-run-20260904-deadbeef"
        failure = self.cli.CoordinatorError("load-run seam reached")

        with mock.patch.object(
            self.cli, "_load_run", side_effect=failure
        ) as load_run:
            with self.assertRaisesRegex(
                self.cli.CoordinatorError, "load-run seam reached"
            ):
                self.cli._evaluate(run_id)

        load_run.assert_called_once_with(run_id)

    def test_cleanup_dispatches_through_legacy_open_run_seam(self) -> None:
        run_id = "qa-run-20260904-deadbeef"
        failure = self.cli.CoordinatorError("cleanup-open seam reached")

        with mock.patch.object(
            self.cli, "_open_run_for_cleanup", side_effect=failure
        ) as open_run:
            with self.assertRaisesRegex(
                self.cli.CoordinatorError, "cleanup-open seam reached"
            ):
                self.cli._cleanup(run_id)

        open_run.assert_called_once_with(run_id)


if __name__ == "__main__":
    unittest.main()
