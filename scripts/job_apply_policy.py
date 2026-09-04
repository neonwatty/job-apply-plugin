#!/usr/bin/env python3
"""Inert local policy authority for bounded Job Apply Auto-submit campaigns.

This compatibility facade preserves the historical import and executable path.
Implementation modules are loaded under a private package name so direct-path
loaders continue to work even when they name this module ``job_apply_policy``.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from typing import Any


_PACKAGE_NAME = "_job_apply_policy_parts"
if _PACKAGE_NAME not in sys.modules:
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
for _source in (_model, _storage):
    for _name in dir(_source):
        if not _name.startswith("__"):
            globals().setdefault(_name, getattr(_source, _name))


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
    return _cli.run(args, PolicyStore)


def main() -> int:
    return _cli.main(PolicyStore)


__all__ = [
    "PolicyStore",
    "PolicyError",
    "SCHEMA_VERSION",
    "STORE_ENV",
    "MAX_APPLICATIONS",
    "MAX_DURATION",
    "LEASE_DURATION",
    "RULE_FIELDS",
    "SENSITIVE_FIELDS",
    "AUTHORIZATION_FIELDS",
    "CAMPAIGN_FIELDS",
    "ATTEMPT_FIELDS",
    "APPLICATION_FIELDS",
    "RECEIPT_FIELDS",
    "CAMPAIGN_STATUSES",
    "APPLICATION_STATUSES",
    "OUTCOMES",
    "CONFIRMATION_FIELDS",
    "utc_now",
    "format_time",
    "parse_time",
    "confirmation_authority_revision",
    "build_parser",
    "run",
    "main",
]


if __name__ == "__main__":
    raise SystemExit(main())
