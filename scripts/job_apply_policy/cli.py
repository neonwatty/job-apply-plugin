"""Command-line adapter for the local policy authority."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .model import OUTCOMES, STORE_ENV, PolicyError, _object

POLICY_DESCRIPTION = """Inert local policy authority for bounded Job Apply Auto-submit campaigns.

This helper only creates and evaluates local policy records. It deliberately has
no browser integration and cannot activate a final control.
"""

def _read_input(path: str) -> dict[str, Any]:
    try:
        if path == "-":
            return _object(json.load(sys.stdin), "input")
        with Path(path).expanduser().open(encoding="utf-8") as source:
            return _object(json.load(source), "input")
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError("input is not a readable JSON object") from error

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=POLICY_DESCRIPTION)
    parser.add_argument("--root", help=f"store root (default: ${STORE_ENV} or ~/.job-apply)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    activate = commands.add_parser("activate")
    activate.add_argument("--input", required=True)
    authorize = commands.add_parser("authorize")
    authorize.add_argument("--input", required=True)
    claim = commands.add_parser("claim-final-action")
    claim.add_argument("--input", required=True, help="fresh observed identity")
    claim.add_argument("--application-ref", required=True)
    claim.add_argument("--lease-id", required=True)
    claim.add_argument("--attempt", required=True, type=int)
    claim.add_argument("--action-capability", required=True)
    outcome = commands.add_parser("record-outcome")
    outcome.add_argument("--campaign-id", required=True)
    outcome.add_argument("--application-ref", required=True)
    outcome.add_argument("--lease-id", required=True)
    outcome.add_argument("--claim-id", required=True)
    outcome.add_argument("--outcome", required=True, choices=sorted(OUTCOMES))
    outcome.add_argument("--confirmation-event")
    outcome.add_argument("--confirmation-capability")
    commands.add_parser("kill")
    commands.add_parser("revoke")
    return parser

def run(args: argparse.Namespace, store_type: type) -> Any:
    configured = args.root or os.environ.get(STORE_ENV)
    root = Path(configured).expanduser() if configured else Path.home() / ".job-apply"
    store = store_type(root)
    if args.command == "status":
        return store.decision()
    if args.command == "activate":
        return store.activate(_read_input(args.input))
    if args.command == "authorize":
        return store.authorize(_read_input(args.input))
    if args.command == "claim-final-action":
        return store.claim_final_action(
            args.application_ref,
            args.lease_id,
            args.attempt,
            _read_input(args.input),
            args.action_capability,
        )
    if args.command == "record-outcome":
        return store.record_outcome(
            args.campaign_id,
            args.application_ref,
            args.lease_id,
            args.claim_id,
            args.outcome,
            _read_input(args.confirmation_event) if args.confirmation_event else None,
            args.confirmation_capability,
        )
    if args.command == "kill":
        return store.kill()
    if args.command == "revoke":
        return store.revoke()
    raise PolicyError("unsupported command")

def main(store_type: type) -> int:
    args = build_parser().parse_args()
    try:
        result = run(args, store_type)
    except PolicyError as error:
        print(f"job-apply-policy: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("job-apply-policy: policy operation failed", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0
