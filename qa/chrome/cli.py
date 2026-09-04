"""Stable command-line parsing, dispatch, diagnostics, and exit codes."""

import argparse
import sys

from qa.chrome.commands import (
    command_check,
    command_reset,
    command_start,
    command_stop,
)
from qa.chrome.paths import UserError, fail, validate_profile


class FacadeRuntime:
    """Resolve leaf dependency lookups against a facade module namespace."""

    def __init__(self, namespace):
        self._namespace = namespace

    def __getattr__(self, name):
        return self._namespace[name]

    def resolve(self):
        return self


LEGACY_STAR_EXPORTS = (
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
)


def _resolve_runtime(runtime):
    return sys.modules[__name__] if runtime is None else runtime


class QuietParser(argparse.ArgumentParser):
    def error(self, _message):
        fail("invalid arguments")


def parse_args(argv, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    parser = runtime.QuietParser(add_help=True)
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start")
    start.add_argument("--profile", required=True)
    start.add_argument("--chrome-path")
    for name in ("check", "stop"):
        child = sub.add_parser(name)
        child.add_argument("--profile", required=True)
    reset = sub.add_parser("reset")
    reset.add_argument("--profile", required=True)
    return parser.parse_args(argv)


def main(argv=None, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    try:
        args = runtime.parse_args(
            runtime.sys.argv[1:] if argv is None else argv
        )
        profile = runtime.validate_profile(args.profile)
        if args.command == "start":
            runtime.command_start(profile, args.chrome_path)
        elif args.command == "check":
            runtime.command_check(profile)
        elif args.command == "stop":
            runtime.command_stop(profile)
        else:
            runtime.command_reset(profile)
        return 0
    except UserError as error:
        runtime.sys.stderr.write(str(error) + "\n")
        return 2
    except KeyboardInterrupt:
        runtime.sys.stderr.write("operation interrupted\n")
        return 130
