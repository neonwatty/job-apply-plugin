from __future__ import annotations

import argparse
import io
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

import qa.promote as facade


LEGACY_STAR_EXPORTS = {
    "APPROVAL_KEYS",
    "Any",
    "BrokerError",
    "COMPILER_VERSION",
    "ContractError",
    "MANIFEST_KEYS",
    "MANIFEST_PATHS",
    "MANIFEST_STRING_CATEGORIES",
    "MAX_DELETE_DEPTH",
    "MAX_DELETE_ENTRIES",
    "MAX_DELETE_ENTRIES_PER_DIRECTORY",
    "MAX_DENIED_TERMS",
    "MAX_DENIED_TERM_CHARS",
    "MAX_JSON_BYTES",
    "PROMOTION_SCHEMA_VERSION",
    "PROVENANCE_KEYS",
    "Path",
    "PrivacyError",
    "PromotionError",
    "REVIEWER",
    "SCANNER_VERSION",
    "annotations",
    "approve_candidate",
    "argparse",
    "compile_candidate",
    "compile_capture",
    "dataclass",
    "datetime",
    "exclusive_rename",
    "exclusive_rename_available",
    "hashlib",
    "json",
    "main",
    "os",
    "promote_candidate",
    "re",
    "scan_tree",
    "secrets",
    "stat",
    "sys",
    "tempfile",
    "timezone",
    "validate_fixture",
}


class PromotionFacadeContractTests(unittest.TestCase):
    def test_facade_freezes_legacy_star_import_inventory(self) -> None:
        self.assertEqual(set(facade.__all__), LEGACY_STAR_EXPORTS)
        self.assertTrue(all(hasattr(facade, name) for name in facade.__all__))

    def test_package_has_a_small_public_surface_and_shared_error_identity(self) -> None:
        import qa.promotion as package

        self.assertEqual(
            set(package.__all__),
            {
                "PromotionError",
                "approve_candidate",
                "compile_candidate",
                "main",
                "promote_candidate",
            },
        )
        self.assertIs(package.PromotionError, facade.PromotionError)

    def test_importing_a_leaf_does_not_import_the_facade(self) -> None:
        command = (
            "import sys; import qa.promotion.transaction; "
            "assert 'qa.promote' not in sys.modules"
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
        from qa.promotion import cli

        arguments = argparse.Namespace(
            command="compile",
            capture=Path("capture"),
            fixture_id="fixture-v1",
            candidate=Path("candidate"),
        )
        parser = mock.Mock()
        parser.parse_args.return_value = arguments
        calls: list[tuple[object, ...]] = []
        runtime = SimpleNamespace(
            PromotionError=facade.PromotionError,
            _parser=lambda: parser,
            approve_candidate=lambda *values: calls.append(("approve", *values)),
            compile_candidate=lambda *values: calls.append(("compile", *values)),
            promote_candidate=lambda *values: calls.append(("promote", *values)),
            sys=SimpleNamespace(stderr=io.StringIO()),
        )

        self.assertEqual(cli.main(runtime), 0)
        self.assertEqual(
            calls,
            [("compile", Path("capture"), "fixture-v1", Path("candidate"))],
        )

    def test_facade_cli_keeps_legacy_function_patch_points(self) -> None:
        arguments = argparse.Namespace(
            command="approve",
            candidate=Path("candidate"),
            reviewer="qa-owner",
        )
        parser = mock.Mock()
        parser.parse_args.return_value = arguments
        calls: list[tuple[object, ...]] = []

        with (
            mock.patch.object(facade, "_parser", return_value=parser),
            mock.patch.object(
                facade,
                "approve_candidate",
                side_effect=lambda *values: calls.append(values),
            ),
        ):
            self.assertEqual(facade.main(), 0)

        self.assertEqual(calls, [(Path("candidate"), "qa-owner")])


if __name__ == "__main__":
    unittest.main()
