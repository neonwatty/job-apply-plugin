#!/usr/bin/env python3
"""Observed synthetic browser + Store + native macOS account verifier."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from qa.account_environment import *
from qa.account_environment import (
    _compile_native,
    _focus_browser,
    _module,
    _native_provider,
    _open_oracle_browser,
    _require_browser_test_dependencies,
    _require_visible_browser_approval,
    _start_browser,
)
from qa.account_walkthrough import (
    _store_walkthrough,
    _workday_scenario_result,
    verify_all,
    verify_oracle_email_only,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify-all")
    verify.add_argument("--provider", required=True)
    verify.add_argument("--owner-approved-visible-browser-tests", action="store_true")
    verify.add_argument("--json", action="store_true")
    oracle = sub.add_parser("verify-oracle-email-only")
    oracle.add_argument("--automation-provider", required=True)
    oracle.add_argument("--owner-approved-visible-browser-tests", action="store_true")
    oracle.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "verify-all":
            result = verify_all(
                args.provider,
                owner_approved_visible_browser_tests=args.owner_approved_visible_browser_tests,
            )
        else:
            result = verify_oracle_email_only(
                args.automation_provider,
                owner_approved_visible_browser_tests=args.owner_approved_visible_browser_tests,
            )
    except ValueError as error:
        print(json.dumps({"passed": False, "error": str(error)}, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
