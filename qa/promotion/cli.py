"""Command-line parsing and dispatch for fixture promotion."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
from typing import Any

from qa.promotion.approval import approve_candidate
from qa.promotion.bindings import PromotionError
from qa.promotion.candidate import compile_candidate
from qa.promotion.transaction import promote_candidate


DESCRIPTION = "Fail-closed compilation, approval, and promotion for replay fixtures."


def _parser(*, _runtime: Any | None = None) -> argparse.ArgumentParser:
    runtime = sys.modules[__name__] if _runtime is None else _runtime
    parser = runtime.argparse.ArgumentParser(description=DESCRIPTION)
    subcommands = parser.add_subparsers(dest="command", required=True)
    compile_parser = subcommands.add_parser("compile")
    compile_parser.add_argument("--capture", type=runtime.Path, required=True)
    compile_parser.add_argument("--fixture-id", required=True)
    compile_parser.add_argument("--candidate", type=runtime.Path, required=True)
    approve_parser = subcommands.add_parser("approve")
    approve_parser.add_argument("--candidate", type=runtime.Path, required=True)
    approve_parser.add_argument("--reviewer", required=True)
    promote_parser = subcommands.add_parser("promote")
    promote_parser.add_argument("--candidate", type=runtime.Path, required=True)
    promote_parser.add_argument("--destination", type=runtime.Path, required=True)
    return parser


def main(_runtime: Any | None = None) -> int:
    runtime = sys.modules[__name__] if _runtime is None else _runtime
    arguments = runtime._parser().parse_args()
    try:
        if arguments.command == "compile":
            runtime.compile_candidate(
                arguments.capture, arguments.fixture_id, arguments.candidate
            )
        elif arguments.command == "approve":
            runtime.approve_candidate(arguments.candidate, arguments.reviewer)
        else:
            runtime.promote_candidate(arguments.candidate, arguments.destination)
    except PromotionError as error:
        print(str(error), file=runtime.sys.stderr)
        return 1
    return 0
