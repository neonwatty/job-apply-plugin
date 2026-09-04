from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path
import shutil
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = REPOSITORY_ROOT / "scripts" / "qa-chrome.py"
CLASS_NAMES = (
    "UserError",
    "Ambiguous",
    "BoundPaths",
    "ControlServer",
    "ControlHandler",
    "QuietParser",
)
CLASS_SIGNATURES = {
    "BoundPaths": "(profile, create_base=False, create_profile=False)",
    "ControlServer": (
        "(address, handler, token, child, cdp_port, browser_path, paths, "
        "ownership_fd, published)"
    ),
    "ControlHandler": "(request, client_address, server)",
    "QuietParser": (
        "(prog=None, usage=None, description=None, epilog=None, parents=[], "
        "formatter_class=<class 'argparse.HelpFormatter'>, prefix_chars='-', "
        "fromfile_prefix_chars=None, argument_default=None, "
        "conflict_handler='error', add_help=True, allow_abbrev=True, "
        "exit_on_error=True)"
    ),
}


def load_launcher(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ChromeLoaderIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.original_sys_path = list(sys.path)
        roots = []
        for root_name in ("first-root", "second-root"):
            scripts = Path(self.temporary.name) / root_name / "scripts"
            scripts.mkdir(parents=True)
            launcher = scripts / "qa-chrome.py"
            shutil.copy2(LAUNCHER, launcher)
            roots.append(launcher)
        self.first = load_launcher(roots[0], "qa_chrome_first_root")
        self.second = load_launcher(roots[1], "qa_chrome_second_root")

    def tearDown(self):
        sys.path[:] = self.original_sys_path
        self.temporary.cleanup()

    def test_retained_facades_keep_independent_descriptor_and_parser_runtimes(self):
        first_descriptor = self.first.UserError("first descriptor runtime")
        second_descriptor = self.second.UserError("second descriptor runtime")
        first_parser = self.first.UserError("first parser runtime")
        second_parser = self.second.UserError("second parser runtime")

        with (
            mock.patch.object(
                self.first, "_open_home", side_effect=first_descriptor
            ),
            mock.patch.object(
                self.second, "_open_home", side_effect=second_descriptor
            ),
            mock.patch.object(self.first, "fail", side_effect=first_parser),
            mock.patch.object(self.second, "fail", side_effect=second_parser),
        ):
            with self.assertRaisesRegex(
                self.first.UserError, "first descriptor runtime"
            ):
                self.first.BoundPaths("first-profile")
            with self.assertRaisesRegex(
                self.second.UserError, "second descriptor runtime"
            ):
                self.second.BoundPaths("second-profile")
            with self.assertRaisesRegex(
                self.first.UserError, "first parser runtime"
            ):
                self.first.QuietParser().parse_args(["--invalid"])
            with self.assertRaisesRegex(
                self.second.UserError, "second parser runtime"
            ):
                self.second.QuietParser().parse_args(["--invalid"])

    def test_retained_facades_keep_independent_control_construction_runtimes(self):
        first_os = SimpleNamespace(
            fstat=lambda _fd: SimpleNamespace(loader="first")
        )
        second_os = SimpleNamespace(
            fstat=lambda _fd: SimpleNamespace(loader="second")
        )
        first_threading = SimpleNamespace(
            BoundedSemaphore=lambda limit: ("first", limit)
        )
        second_threading = SimpleNamespace(
            BoundedSemaphore=lambda limit: ("second", limit)
        )

        with (
            mock.patch.object(
                self.first.http.server.HTTPServer, "__init__", return_value=None
            ),
            mock.patch.object(self.first, "os", first_os),
            mock.patch.object(self.second, "os", second_os),
            mock.patch.object(
                self.first, "_identity", side_effect=lambda st: (st.loader, 1)
            ),
            mock.patch.object(
                self.second, "_identity", side_effect=lambda st: (st.loader, 2)
            ),
            mock.patch.object(self.first, "threading", first_threading),
            mock.patch.object(self.second, "threading", second_threading),
            mock.patch.object(self.first, "MAX_CONTROL_CONNECTIONS", 3),
            mock.patch.object(self.second, "MAX_CONTROL_CONNECTIONS", 5),
        ):
            first_server = self.first.ControlServer(
                ("127.0.0.1", 0),
                self.first.ControlHandler,
                "first-token",
                object(),
                9001,
                "/first/chrome",
                object(),
                11,
                {},
            )
            second_server = self.second.ControlServer(
                ("127.0.0.1", 0),
                self.second.ControlHandler,
                "second-token",
                object(),
                9002,
                "/second/chrome",
                object(),
                12,
                {},
            )

        self.assertEqual(first_server.ownership_identity, ("first", 1))
        self.assertEqual(first_server.connection_slots, ("first", 3))
        self.assertEqual(second_server.ownership_identity, ("second", 2))
        self.assertEqual(second_server.connection_slots, ("second", 5))

    def test_each_facade_retains_exact_loader_local_class_metadata(self):
        for module, module_name in (
            (self.first, "qa_chrome_first_root"),
            (self.second, "qa_chrome_second_root"),
        ):
            for name in CLASS_NAMES:
                with self.subTest(module=module_name, name=name):
                    value = getattr(module, name)
                    self.assertEqual(value.__name__, name)
                    self.assertEqual(value.__qualname__, name)
                    self.assertEqual(value.__module__, module_name)
                    self.assertIsNone(getattr(value, "__annotations__", None))
            for name, signature in CLASS_SIGNATURES.items():
                with self.subTest(module=module_name, signature=name):
                    self.assertEqual(
                        str(inspect.signature(getattr(module, name))), signature
                    )
        for name in CLASS_NAMES:
            with self.subTest(identity=name):
                self.assertIsNot(
                    getattr(self.first, name), getattr(self.second, name)
                )

    def test_direct_package_classes_remain_leaf_local_after_facade_loads(self):
        import qa.chrome as package
        from qa.chrome import cli, control, paths

        package_os = SimpleNamespace(
            fstat=lambda _fd: SimpleNamespace(loader="package")
        )
        package_threading = SimpleNamespace(
            BoundedSemaphore=lambda limit: ("package", limit)
        )
        with mock.patch.object(
            paths,
            "_open_home",
            side_effect=paths.UserError("package descriptor runtime"),
        ):
            with self.assertRaisesRegex(
                paths.UserError, "package descriptor runtime"
            ):
                package.BoundPaths("package-profile")
        with mock.patch.object(
            cli, "fail", side_effect=paths.UserError("package parser runtime")
        ):
            with self.assertRaisesRegex(paths.UserError, "package parser runtime"):
                cli.QuietParser().parse_args(["--invalid"])
        with (
            mock.patch.object(
                control.http.server.HTTPServer, "__init__", return_value=None
            ),
            mock.patch.object(control, "os", package_os),
            mock.patch.object(
                control, "_identity", side_effect=lambda st: (st.loader, 4)
            ),
            mock.patch.object(control, "threading", package_threading),
            mock.patch.object(control, "MAX_CONTROL_CONNECTIONS", 7),
        ):
            server = package.ControlServer(
                ("127.0.0.1", 0),
                package.ControlHandler,
                "package-token",
                object(),
                9003,
                "/package/chrome",
                object(),
                13,
                {},
            )

        self.assertEqual(server.ownership_identity, ("package", 4))
        self.assertEqual(server.connection_slots, ("package", 7))
        for facade in (self.first, self.second):
            self.assertIsNot(facade.UserError, paths.UserError)
            self.assertIsNot(facade.BoundPaths, paths.BoundPaths)
            self.assertIsNot(facade.ControlServer, control.ControlServer)
            self.assertIsNot(facade.QuietParser, cli.QuietParser)
        self.assertEqual(paths.BoundPaths.__module__, "qa.chrome.paths")
        self.assertEqual(control.ControlServer.__module__, "qa.chrome.control")
        self.assertEqual(cli.QuietParser.__module__, "qa.chrome.cli")


if __name__ == "__main__":
    unittest.main()
