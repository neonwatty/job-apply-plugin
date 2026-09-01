#!/usr/bin/env python3
"""Redacted task-level CLI for canonical Job Apply records."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any


def load_store_module() -> Any:
    path = Path(__file__).resolve().with_name("job-apply-store.py")
    spec = importlib.util.spec_from_file_location("job_apply_task_store", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("canonical store unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE: Any | None = None


def store_module() -> Any:
    global STORE
    if STORE is None:
        STORE = load_store_module()
    return STORE


class TaskParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        raise ValueError("invalid command")


def build_parser() -> argparse.ArgumentParser:
    parser = TaskParser(description=__doc__)
    parser.add_argument("--root")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("snapshot")
    activity = commands.add_parser("activity")
    activity.add_argument("--id", required=True)
    intake = commands.add_parser("intake")
    intake.add_argument("--input", required=True)
    select = commands.add_parser("select")
    select.add_argument("--id", required=True)
    select.add_argument("--expected-revision", required=True, type=int)
    select.add_argument("--owner-confirmed", action="store_true")
    resolve = commands.add_parser("resolve-pending-answer")
    resolve.add_argument("--id", required=True)
    resolve.add_argument("--reference", required=True)
    resolve.add_argument("--expected-job-revision", required=True, type=int)
    resolve.add_argument("--expected-session-revision", required=True, type=int)
    resolve.add_argument("--expected-answer-revision", required=True, type=int)
    resolve.add_argument("--owner-confirmed", action="store_true")
    return parser


def resolve_store(args: argparse.Namespace) -> Any:
    store = store_module()
    configured = args.root or os.environ.get(store.STORE_ENV)
    root = Path(configured).expanduser() if configured else Path.home() / ".job-apply"
    return store.Store(root)


def read_intake(path_value: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path_value).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid intake") from error
    if not isinstance(value, dict):
        raise ValueError("invalid intake")
    return value


def run(args: argparse.Namespace) -> dict[str, Any]:
    store = resolve_store(args)
    if args.command == "snapshot":
        return {"ok": True, "command": "snapshot", "snapshot": store.task_snapshot()}
    if args.command == "activity":
        return {
            "ok": True,
            "command": "activity",
            "jobId": args.id,
            "activity": store.get_job_activity(args.id),
        }
    if args.command == "intake":
        return {
            "ok": True,
            "command": "intake",
            **store.intake_task_job(read_intake(args.input), origin="agent"),
        }
    if args.command == "select":
        return {
            "ok": True,
            "command": "select",
            **store.select_task_job_ready(
                args.id, args.expected_revision, args.owner_confirmed
            ),
        }
    if args.command == "resolve-pending-answer":
        return {
            "ok": True,
            "command": "resolve-pending-answer",
            **store.resolve_pending_answer(
                args.id, args.reference, args.expected_job_revision,
                args.expected_session_revision, args.expected_answer_revision,
                args.owner_confirmed,
            ),
        }
    raise ValueError("invalid command")


def classify(error: BaseException) -> tuple[str, str]:
    if isinstance(error, ValueError):
        return "invalid_request", "The task request is invalid."
    if STORE is not None and isinstance(error, STORE.StoreError):
        message = str(error)
        if "owner confirmation" in message:
            return "owner_confirmation_required", "Explicit owner confirmation is required."
        if "revision conflict" in message:
            return "stale_revision", "A selected canonical revision is stale."
        if "reference is stale" in message:
            return "stale_revision", "The pending question reference is stale."
        if "sensitive pending" in message:
            return "sensitive_answer", "Sensitive answers require fresh owner reconfirmation in Answers."
        if "not accepted and confirmed" in message or "no referenced answer" in message:
            return "answer_unavailable", "The referenced answer is not accepted and confirmed."
        if "preflight failed" in message:
            return "preflight_failed", "The selected job is not ready."
        if "intake conflict" in message or "one active job" in message:
            return "job_identity_conflict", "The URL does not resolve to one active job."
        if "unavailable" in message or "does not exist" in message:
            return "job_unavailable", "The requested job is unavailable."
        if "intake invalid" in message or "input" in message or "URL" in message:
            return "invalid_request", "The task request is invalid."
        return "store_rejected", "The canonical store rejected the task request."
    return "store_unavailable", "The canonical store is unavailable."


def emit(value: dict[str, Any], stream: Any = sys.stdout) -> None:
    json.dump(value, stream, sort_keys=True, ensure_ascii=False)
    stream.write("\n")


def main() -> int:
    try:
        args = build_parser().parse_args()
        result = run(args)
    except Exception as error:
        code, message = classify(error)
        emit({"ok": False, "error": {"code": code, "message": message}})
        return 2
    emit(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
