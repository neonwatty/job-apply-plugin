#!/usr/bin/env python3
"""Deterministic, value-free oracle for resume extraction onboarding."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from qa.resume_extraction_companion import (
    DEFAULT_FIXTURE,
    EXPECTED_FIXTURE_SHA256,
    RECEIPT_KEYS,
    STORE,
    STORE_SCRIPT,
    WORKSPACE,
    WORKSPACE_SCRIPT,
    Companion,
    OracleFailure,
    _fixture_path,
    _load_workspace,
    _require,
    _store_path,
)
from qa.resume_extraction_scenario import Oracle


def _failed_receipt() -> dict[str, bool]:
    return {key: False for key in RECEIPT_KEYS}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--fixture", default=DEFAULT_FIXTURE.as_posix())
    parser.add_argument("--store-root")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        fixture = _fixture_path(args.fixture)
        if args.store_root:
            receipt = Oracle(fixture, _store_path(args.store_root)).run()
        else:
            with tempfile.TemporaryDirectory(prefix="job-apply-resume-oracle-") as temporary:
                receipt = Oracle(fixture, Path(temporary) / "store").run()
    except Exception:
        print(json.dumps(_failed_receipt(), sort_keys=True, separators=(",", ":")))
        return 1
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
