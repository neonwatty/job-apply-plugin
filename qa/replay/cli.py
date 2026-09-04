"""Command-line parsing and dispatch for replay coordination."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

from qa.replay.auto_submit import _verify_auto_submit
from qa.replay.cleanup import _cleanup
from qa.replay.evaluate import _evaluate
from qa.replay.lifecycle import _record_transition, _resolve_route
from qa.replay.prepare import _prepare
from qa.replay.secure_io import CoordinatorError


DESCRIPTION = "Prepare and evaluate supervised local Job Apply replay runs."


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def build_parser(*, _runtime: Any | None = None) -> argparse.ArgumentParser:
    runtime = _resolve_runtime(_runtime)
    parser = runtime.argparse.ArgumentParser(description=DESCRIPTION)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--fixture", required=True)
    prepare.add_argument("--scenario", required=True)
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--run-id", required=True)
    started = commands.add_parser("started")
    started.add_argument("--run-id", required=True)
    reviewed = commands.add_parser("reviewed")
    reviewed.add_argument("--run-id", required=True)
    resolve = commands.add_parser("resolve")
    resolve.add_argument("--route-token", required=True)
    cleanup = commands.add_parser("cleanup")
    cleanup.add_argument("--run-id", required=True)
    verify_auto_submit = commands.add_parser("verify-auto-submit")
    verify_auto_submit.add_argument("--fixture", required=True, type=runtime.Path)
    verify_auto_submit.add_argument("--json", action="store_true")
    return parser


def main(
    argv: list[str] | None = None, *, _runtime: Any | None = None
) -> int:
    runtime = _resolve_runtime(_runtime)
    arguments = runtime.build_parser().parse_args(argv)
    try:
        if arguments.command == "prepare":
            result = runtime._prepare(arguments.fixture, arguments.scenario)
            code = 0
        elif arguments.command == "evaluate":
            code, result = runtime._evaluate(arguments.run_id)
        elif arguments.command in {"started", "reviewed"}:
            result = runtime._record_transition(
                arguments.run_id, arguments.command
            )
            code = 0
        elif arguments.command == "resolve":
            result = runtime._resolve_route(arguments.route_token)
            code = 0
        elif arguments.command == "verify-auto-submit":
            result = runtime._verify_auto_submit(arguments.fixture)
            code = 0 if result["status"] == "passed" else 1
        else:
            result = runtime._cleanup(arguments.run_id)
            code = 0
        print(runtime.json.dumps(result, sort_keys=True, separators=(",", ":")))
        return code
    except CoordinatorError as error:
        print(str(error), file=runtime.sys.stderr)
        return 2
