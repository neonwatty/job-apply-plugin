from __future__ import annotations

import argparse
import contextlib
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

from tests.support.chrome_launcher_case import ChromeLauncherCase


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = REPOSITORY_ROOT / "scripts" / "qa-chrome.py"


def load_launcher():
    spec = importlib.util.spec_from_file_location("qa_chrome_launcher", LAUNCHER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


LEGACY_STAR_EXPORTS = {
    "Ambiguous",
    "BoundPaths",
    "ControlHandler",
    "ControlServer",
    "DIR_MODE",
    "FILE_MODE",
    "MAX_BODY",
    "MAX_CONTROL_CONNECTIONS",
    "ORIGIN",
    "PROFILE_RE",
    "Path",
    "QuietParser",
    "REQUEST_TIMEOUT",
    "ROOT_NAME",
    "SHUTDOWN_TIMEOUT",
    "STARTUP_TIMEOUT",
    "UserError",
    "argparse",
    "command_check",
    "command_reset",
    "command_start",
    "command_stop",
    "discover_chrome",
    "emit",
    "errno",
    "fail",
    "fcntl",
    "hashlib",
    "hmac",
    "http",
    "json",
    "main",
    "os",
    "parse_args",
    "re",
    "secrets",
    "signal",
    "socket",
    "socketserver",
    "stat",
    "subprocess",
    "sys",
    "threading",
    "time",
    "urllib",
    "validate_profile",
}


LEGACY_CALLABLE_SIGNATURES = {
    "fail": "(message)",
    "emit": "(payload)",
    "validate_profile": "(value)",
    "_identity": "(st)",
    "_entry_stat": "(parent_fd, name)",
    "_entry_absent": "(parent_fd, name)",
    "_validate_dir_stat": "(st, device)",
    "_open_child_dir": "(parent_fd, name, device, create=False)",
    "_open_home": "()",
    "BoundPaths": "(profile, create_base=False, create_profile=False)",
    "_owner_name": "(profile)",
    "_ownership_name": "(profile)",
    "_open_owner": "(paths)",
    "_observe_owner": "(paths)",
    "_write_owner_runtime": "(owner_fd, runtime_st)",
    "_owner_matches_runtime": "(paths)",
    "_safe_regular": "(dir_fd, name, device, max_bytes=4096)",
    "_read_json": "(paths, name, keys)",
    "_atomic_json": "(paths, name, value)",
    "discover_chrome": "(explicit)",
    "_browser_path_hash": "(browser_path)",
    "_cdp_browser_path": "(port)",
    "_probe_cdp": "(port, browser_path=None, browser_path_hash=None)",
    "_public_ready": "(profile, port)",
    "_control_request": "(paths, action)",
    "ControlServer": (
        "(address, handler, token, child, cdp_port, browser_path, paths, "
        "ownership_fd, published)"
    ),
    "ControlHandler": "(request, client_address, server)",
    "_read_new_devtools": "(paths, launched_at, child, expected_port)",
    "_unlink_identity": "(dir_fd, name, identity, device)",
    "_cleanup_runtime": "(paths, published)",
    "_terminate_exact_child": "(child)",
    "_supervisor": "(paths, chrome, ownership_fd, owner_fd, ready_fd)",
    "_remove_stale_devtools": "(paths)",
    "command_start": "(profile, chrome_path)",
    "command_check": "(profile)",
    "command_stop": "(profile)",
    "_manual_profile_path": "(profile)",
    "_emit_manual_reset": "(profile)",
    "command_reset": "(profile)",
    "QuietParser": (
        "(prog=None, usage=None, description=None, epilog=None, parents=[], "
        "formatter_class=<class 'argparse.HelpFormatter'>, prefix_chars='-', "
        "fromfile_prefix_chars=None, argument_default=None, "
        "conflict_handler='error', add_help=True, allow_abbrev=True, "
        "exit_on_error=True)"
    ),
    "parse_args": "(argv)",
    "main": "(argv=None)",
}


EXPECTED_HELP = """usage: qa-chrome.py [-h] {start,check,stop,reset} ...

positional arguments:
  {start,check,stop,reset}

optional arguments:
  -h, --help            show this help message and exit
"""


class ChromeFacadeContractTests(unittest.TestCase):
    def test_facade_freezes_legacy_star_import_inventory(self):
        launcher = load_launcher()

        self.assertEqual(set(launcher.__all__), LEGACY_STAR_EXPORTS)
        self.assertTrue(all(hasattr(launcher, name) for name in launcher.__all__))

    def test_facade_preserves_every_callable_signature_and_metadata(self):
        launcher = load_launcher()

        for name, signature in LEGACY_CALLABLE_SIGNATURES.items():
            with self.subTest(name=name):
                value = getattr(launcher, name)
                self.assertEqual(str(inspect.signature(value)), signature)
                self.assertEqual(value.__name__, name)
                self.assertEqual(getattr(value, "__annotations__", {}), {})
                if inspect.isfunction(value):
                    self.assertEqual(value.__module__, "qa_chrome_launcher")
        self.assertEqual(
            launcher._observe_owner.__doc__,
            "Observe complete per-profile ownership without creating or changing it.",
        )

    def test_package_exports_shared_security_type_identities(self):
        launcher = load_launcher()
        import qa.chrome as package
        from qa.chrome import control, paths

        self.assertEqual(
            set(package.__all__),
            {
                "Ambiguous",
                "BoundPaths",
                "ControlHandler",
                "ControlServer",
                "UserError",
                "check",
                "discover_chrome",
                "main",
                "reset",
                "start",
                "stop",
                "validate_profile",
            },
        )
        self.assertIs(package.UserError, paths.UserError)
        self.assertIs(package.UserError, launcher.UserError)
        self.assertIs(package.Ambiguous, paths.Ambiguous)
        self.assertIs(package.Ambiguous, launcher.Ambiguous)
        self.assertIs(package.BoundPaths, paths.BoundPaths)
        self.assertIs(package.BoundPaths, launcher.BoundPaths)
        self.assertIs(package.ControlServer, control.ControlServer)
        self.assertIs(package.ControlServer, launcher.ControlServer)
        self.assertIs(package.ControlHandler, control.ControlHandler)
        self.assertIs(package.ControlHandler, launcher.ControlHandler)

    def test_importing_each_leaf_never_imports_the_hyphenated_facade(self):
        modules = (
            "paths",
            "owner",
            "discovery",
            "control",
            "supervisor",
            "commands",
            "cli",
        )
        command = (
            "import importlib, sys; "
            f"mods={modules!r}; "
            "[importlib.import_module('qa.chrome.' + name) for name in mods]; "
            "assert 'qa_chrome_launcher' not in sys.modules"
        )

        result = subprocess.run(
            [sys.executable, "-c", command],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_split_cli_dispatches_through_a_supplied_runtime(self):
        from qa.chrome import cli

        calls = []
        runtime = SimpleNamespace(
            UserError=cli.UserError,
            parse_args=lambda argv: argparse.Namespace(
                command="check", profile="runtime-profile"
            ),
            validate_profile=lambda profile: profile,
            command_check=lambda profile: calls.append(profile),
            command_start=lambda *_args: self.fail("wrong command"),
            command_stop=lambda *_args: self.fail("wrong command"),
            command_reset=lambda *_args: self.fail("wrong command"),
            sys=SimpleNamespace(stderr=io.StringIO()),
        )

        self.assertEqual(cli.main([], _runtime=runtime), 0)
        self.assertEqual(calls, ["runtime-profile"])
        self.assertEqual(runtime.sys.stderr.getvalue(), "")

    def test_facade_main_keeps_parser_validation_and_command_patch_points(self):
        launcher = load_launcher()
        arguments = argparse.Namespace(command="reset", profile="patched-profile")

        with (
            mock.patch.object(launcher, "parse_args", return_value=arguments) as parse,
            mock.patch.object(
                launcher, "validate_profile", return_value="validated-profile"
            ) as validate,
            mock.patch.object(launcher, "command_reset") as reset,
        ):
            self.assertEqual(launcher.main(["ignored"]), 0)

        parse.assert_called_once_with(["ignored"])
        validate.assert_called_once_with("patched-profile")
        reset.assert_called_once_with("validated-profile")

    def test_facade_command_and_control_helpers_keep_nested_patch_points(self):
        launcher = load_launcher()
        discovery_failure = launcher.UserError("discovery seam reached")

        with mock.patch.object(
            launcher, "discover_chrome", side_effect=discovery_failure
        ) as discover:
            with self.assertRaisesRegex(launcher.UserError, "discovery seam reached"):
                launcher.command_start("patched-profile", "/absolute/chrome")
        discover.assert_called_once_with("/absolute/chrome")

        read_failure = launcher.Ambiguous("read seam reached")
        paths = SimpleNamespace(name="patched-profile")
        with mock.patch.object(
            launcher, "_read_json", side_effect=read_failure
        ) as read_json:
            with self.assertRaisesRegex(launcher.Ambiguous, "read seam reached"):
                launcher._control_request(paths, "check")
        read_json.assert_called_once_with(
            paths,
            "control.json",
            {"version", "port", "token", "generation"},
        )

    def test_top_level_help_output_is_byte_stable(self):
        result = subprocess.run(
            [sys.executable, str(LAUNCHER), "--help"],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, EXPECTED_HELP)
        self.assertEqual(result.stderr, "")


class ChromeChildTerminationContractTests(unittest.TestCase):
    class Child:
        def __init__(self, poll_result=None, time_out=False):
            self.poll_result = poll_result
            self.time_out = time_out
            self.events = []

        def poll(self):
            self.events.append(("poll",))
            return self.poll_result

        def terminate(self):
            self.events.append(("terminate",))

        def kill(self):
            self.events.append(("kill",))

        def wait(self, timeout=None):
            self.events.append(("wait", timeout))
            if self.time_out:
                self.time_out = False
                raise subprocess.TimeoutExpired("chrome", timeout)
            return 0

    def test_termination_reaps_an_already_exited_child_without_signaling(self):
        launcher = load_launcher()
        child = self.Child(poll_result=0)

        launcher._terminate_exact_child(child)

        self.assertEqual(child.events, [("poll",), ("wait", None)])

    def test_termination_escalates_only_after_the_retained_child_times_out(self):
        launcher = load_launcher()
        child = self.Child(time_out=True)

        with mock.patch.object(
            launcher.time, "monotonic", side_effect=(10.0, 10.25, 10.5)
        ):
            launcher._terminate_exact_child(child)

        self.assertEqual(
            child.events,
            [
                ("poll",),
                ("terminate",),
                ("wait", 3.75),
                ("kill",),
                ("wait", 3.5),
            ],
        )


class ChromePackageRuntimeTests(ChromeLauncherCase):
    def test_package_commands_share_complete_authenticated_runtime(self):
        import qa.chrome as package

        package_fake = Path(self.tmp.name) / "package chrome"
        package_fake.write_text(
            self.fake.read_text().replace(
                "server.serve_forever()",
                "timer = threading.Timer(4, server.shutdown); timer.daemon = True; "
                "timer.start(); server.serve_forever()",
            )
        )
        package_fake.chmod(0o700)
        output = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True):
            with contextlib.redirect_stdout(output):
                package.start("package-runtime", str(package_fake))
            ready = json.loads(output.getvalue())
            self.assertEqual(ready["status"], "ready")

            output.seek(0)
            output.truncate()
            with contextlib.redirect_stdout(output):
                package.check("package-runtime")
            self.assertEqual(json.loads(output.getvalue())["status"], "ready")

            output.seek(0)
            output.truncate()
            with contextlib.redirect_stdout(output):
                package.stop("package-runtime")
            self.assertEqual(json.loads(output.getvalue())["status"], "stopped")


if __name__ == "__main__":
    unittest.main()
