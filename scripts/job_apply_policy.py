#!/usr/bin/env python3
"""Inert local policy authority for bounded Job Apply Auto-submit campaigns.

This compatibility facade preserves the historical import and executable path.
Implementation modules are loaded under a private package name so direct-path
loaders continue to work even when they name this module ``job_apply_policy``.
"""

from __future__ import annotations

import importlib
import secrets
import sys
import types
from pathlib import Path
from typing import Any


_PACKAGE_NAME = f"_job_apply_policy_parts_{secrets.token_hex(8)}"
_package = types.ModuleType(_PACKAGE_NAME)
_package.__path__ = [str(Path(__file__).with_suffix(""))]
_package.__package__ = _PACKAGE_NAME
sys.modules[_PACKAGE_NAME] = _package

_model = importlib.import_module(f"{_PACKAGE_NAME}.model")
_storage = importlib.import_module(f"{_PACKAGE_NAME}.storage")
_campaigns = importlib.import_module(f"{_PACKAGE_NAME}.campaigns")
_authorization_module = importlib.import_module(f"{_PACKAGE_NAME}.authorization")
_outcomes = importlib.import_module(f"{_PACKAGE_NAME}.outcomes")
_cli = importlib.import_module(f"{_PACKAGE_NAME}.cli")

# Preserve historical module attributes, including private validation helpers
# used by compatibility tests and local callers.
for _source in (
    _model,
    _storage,
    _campaigns,
    _authorization_module,
    _outcomes,
    _cli,
):
    for _name in dir(_source):
        if not _name.startswith("__"):
            globals()[_name] = getattr(_source, _name)


class PolicyStore(
    _storage.StorageMixin,
    _campaigns.CampaignMixin,
    _authorization_module.AuthorizationMixin,
    _outcomes.OutcomesMixin,
):
    """Compatibility composition of the split policy implementation."""

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        # Resolve through the facade so existing monkey-patches remain effective.
        _atomic_json(path, payload)


_read_input = _cli._read_input
build_parser = _cli.build_parser


def run(args: Any) -> Any:
    configured = args.root or os.environ.get(STORE_ENV)
    root = Path(configured).expanduser() if configured else Path.home() / ".job-apply"
    store = PolicyStore(root)
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


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(args)
    except PolicyError as error:
        print(f"job-apply-policy: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("job-apply-policy: policy operation failed", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


__all__ = [
    "CAMPAIGN_FIELDS",
    "APPLICATION_FIELDS",
    "APPLICATION_STATUSES",
    "ATS",
    "ATTEMPT_FIELDS",
    "AUTHORIZATION_FIELDS",
    "Any",
    "CAMPAIGN_STATUSES",
    "CONFIRMATION_FIELDS",
    "Callable",
    "FINGERPRINT",
    "Iterator",
    "LEASE_DURATION",
    "MAX_APPLICATIONS",
    "MAX_DURATION",
    "OUTCOMES",
    "Path",
    "PolicyError",
    "PolicyStore",
    "RECEIPT_FIELDS",
    "REFERENCE",
    "RULE_FIELDS",
    "SCHEMA_VERSION",
    "SENSITIVE_FIELDS",
    "STORE_ENV",
    "annotations",
    "argparse",
    "build_parser",
    "confirmation_authority_revision",
    "contextmanager",
    "datetime",
    "fcntl",
    "format_time",
    "hashlib",
    "hmac",
    "json",
    "main",
    "os",
    "parse_time",
    "re",
    "run",
    "secrets",
    "sys",
    "tempfile",
    "timedelta",
    "timezone",
    "urlsplit",
    "utc_now",
]


if __name__ == "__main__":
    raise SystemExit(main())
