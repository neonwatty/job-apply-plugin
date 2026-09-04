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
    return module, spec


class ChromeLoaderIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.original_sys_path = list(sys.path)
        self.saved_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "qa" or name.startswith("qa.chrome")
        }
        self._clear_canonical_modules()
        self.roots = []
        self.launchers = []
        for root_name in ("first-root", "second-root"):
            root = Path(self.temporary.name) / root_name
            scripts = root / "scripts"
            scripts.mkdir(parents=True)
            launcher = scripts / "qa-chrome.py"
            shutil.copy2(LAUNCHER, launcher)
            qa_root = root / "qa"
            qa_root.mkdir()
            shutil.copy2(REPOSITORY_ROOT / "qa" / "__init__.py", qa_root)
            shutil.copytree(
                REPOSITORY_ROOT / "qa" / "chrome",
                qa_root / "chrome",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
            self.roots.append(root)
            self.launchers.append(launcher)
        self.first, self.first_spec = self._load_root(
            0, "qa_chrome_first_root"
        )
        self.second, self.second_spec = self._load_root(
            1, "qa_chrome_second_root"
        )

    def tearDown(self):
        sys.path[:] = self.original_sys_path
        temporary_root = Path(self.temporary.name)
        for name, module in tuple(sys.modules.items()):
            source = getattr(module, "__file__", None)
            if (
                name == "qa"
                or name.startswith("qa.chrome")
                or source is not None
                and Path(source).is_relative_to(temporary_root)
            ):
                del sys.modules[name]
        sys.modules.update(self.saved_modules)
        self.temporary.cleanup()

    def _clear_canonical_modules(self):
        for name in tuple(sys.modules):
            if name == "qa" or name.startswith("qa.chrome"):
                del sys.modules[name]

    def _load_root(self, index, name):
        root_strings = {str(root) for root in self.roots}
        sys.path[:] = [entry for entry in sys.path if entry not in root_strings]
        return load_launcher(self.launchers[index], name)

    @staticmethod
    def _private_modules(package_name):
        return {
            name: module
            for name, module in sys.modules.items()
            if name == package_name or name.startswith(package_name + ".")
        }

    @staticmethod
    def _capture_error(call):
        try:
            call()
        except Exception as error:
            return error
        raise AssertionError("expected an error")

    def test_complete_roots_use_distinct_private_packages_in_both_load_orders(self):
        for iteration, order in enumerate(((0, 1), (1, 0))):
            with self.subTest(order=order):
                self._clear_canonical_modules()
                leading, _ = self._load_root(
                    order[0], f"qa_chrome_order_{iteration}_leading"
                )
                following, _ = self._load_root(
                    order[1], f"qa_chrome_order_{iteration}_following"
                )
                self.assertIsNot(leading._paths, following._paths)
                self.assertNotEqual(
                    getattr(leading, "_PACKAGE_NAME", None),
                    getattr(following, "_PACKAGE_NAME", None),
                )
                self.assertIsNot(
                    getattr(leading, "_package", None),
                    getattr(following, "_package", None),
                )
                for facade, root_index in (
                    (leading, order[0]),
                    (following, order[1]),
                ):
                    expected = (
                        self.roots[root_index] / "qa" / "chrome"
                    ).resolve()
                    self.assertTrue(
                        Path(facade._paths.__file__).resolve().is_relative_to(
                            expected
                        )
                    )

    def test_cleared_canonical_modules_cannot_redirect_retained_root_classes(self):
        self._clear_canonical_modules()
        first, _ = self._load_root(0, "qa_chrome_cleared_first")
        first_paths, first_cli, first_control = (
            first._paths,
            first._cli,
            first._control,
        )
        self._clear_canonical_modules()
        second, _ = self._load_root(1, "qa_chrome_cleared_second")
        second_paths, second_cli, second_control = (
            second._paths,
            second._cli,
            second._control,
        )

        first_open_error = first_paths.UserError("first root descriptor")
        second_open_error = second_paths.UserError("second root descriptor")
        with (
            mock.patch.object(
                first_paths, "_open_home", side_effect=first_open_error
            ),
            mock.patch.object(
                second_paths, "_open_home", side_effect=second_open_error
            ),
        ):
            first_error = self._capture_error(
                lambda: first_paths.BoundPaths("first-profile")
            )
            second_error = self._capture_error(
                lambda: second_paths.BoundPaths("second-profile")
            )
        self.assertIs(type(first_error), first_paths.UserError)
        self.assertEqual(str(first_error), "first root descriptor")
        self.assertIs(type(second_error), second_paths.UserError)
        self.assertEqual(str(second_error), "second root descriptor")

        with (
            mock.patch.object(
                first_cli,
                "fail",
                side_effect=first_paths.UserError("first root parser"),
            ),
            mock.patch.object(
                second_cli,
                "fail",
                side_effect=second_paths.UserError("second root parser"),
            ),
        ):
            first_error = self._capture_error(
                lambda: first_cli.QuietParser().parse_args(["--invalid"])
            )
            second_error = self._capture_error(
                lambda: second_cli.QuietParser().parse_args(["--invalid"])
            )
        self.assertIs(type(first_error), first_paths.UserError)
        self.assertEqual(str(first_error), "first root parser")
        self.assertIs(type(second_error), second_paths.UserError)
        self.assertEqual(str(second_error), "second root parser")

        runtimes = (
            (first_control, "first", 1, 3),
            (second_control, "second", 2, 5),
        )
        with mock.patch.object(
            first_control.http.server.HTTPServer, "__init__", return_value=None
        ):
            servers = []
            for control, label, identity, limit in runtimes:
                with (
                    mock.patch.object(
                        control,
                        "os",
                        SimpleNamespace(
                            fstat=lambda _fd, label=label: SimpleNamespace(
                                loader=label
                            )
                        ),
                    ),
                    mock.patch.object(
                        control,
                        "_identity",
                        side_effect=lambda st, identity=identity: (
                            st.loader,
                            identity,
                        ),
                    ),
                    mock.patch.object(
                        control,
                        "threading",
                        SimpleNamespace(
                            BoundedSemaphore=lambda value, label=label: (
                                label,
                                value,
                            )
                        ),
                    ),
                    mock.patch.object(control, "MAX_CONTROL_CONNECTIONS", limit),
                ):
                    servers.append(
                        control.ControlServer(
                            ("127.0.0.1", 0),
                            control.ControlHandler,
                            label + "-token",
                            object(),
                            9000 + identity,
                            "/" + label + "/chrome",
                            object(),
                            10 + identity,
                            {},
                        )
                    )
        self.assertEqual(servers[0].ownership_identity, ("first", 1))
        self.assertEqual(servers[0].connection_slots, ("first", 3))
        self.assertEqual(servers[1].ownership_identity, ("second", 2))
        self.assertEqual(servers[1].connection_slots, ("second", 5))

    def test_reload_is_bounded_refreshes_stale_patches_and_preserves_other_root(self):
        package_name = getattr(self.first, "_PACKAGE_NAME", None)
        second_name = getattr(self.second, "_PACKAGE_NAME", None)
        self.assertIsNotNone(package_name)
        self.assertIsNotNone(second_name)
        self.assertNotEqual(package_name, second_name)
        first_entries = self._private_modules(package_name)
        second_entries = self._private_modules(second_name)
        self.assertTrue(first_entries)
        self.assertTrue(second_entries)
        self.assertIsNot(self.first._package, self.second._package)

        stale = object()
        old_package = self.first._package
        old_bound_paths = old_package.BoundPaths
        self.first._paths._open_home = stale
        self.first.fail = stale
        assert self.first_spec.loader is not None
        self.first_spec.loader.exec_module(self.first)

        self.assertEqual(self.first._PACKAGE_NAME, package_name)
        self.assertEqual(
            set(self._private_modules(package_name)), set(first_entries)
        )
        for name, module in second_entries.items():
            self.assertIs(sys.modules[name], module)
        self.assertIsNot(self.first._paths._open_home, stale)
        self.assertIsNot(self.first.fail, stale)

        refreshed_error = self.first._paths.UserError("refreshed first root")
        with mock.patch.object(
            self.first._paths, "_open_home", side_effect=refreshed_error
        ):
            error = self._capture_error(
                lambda: old_bound_paths("retained-profile")
            )
        self.assertIs(type(error), self.first._paths.UserError)
        self.assertEqual(str(error), "refreshed first root")

        self.first_spec.loader.exec_module(self.first)
        self.assertEqual(
            set(self._private_modules(package_name)), set(first_entries)
        )

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
