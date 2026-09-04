"""Root-local canonical dependencies for Store account domain leaves."""

from __future__ import annotations

import hashlib
import importlib.util
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

from .validation.accounts import (
    _optional_email,
    _validate_automation_settings_record as _validate_settings,
    _validate_employer_account_record as _validate_account,
)


_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
_PACKAGE_NAME = "_job_apply_account_runtime_" + hashlib.sha256(
    str(_SCRIPTS_ROOT).encode("utf-8")
).hexdigest()
_REGISTRY_NAMES = {
    "job_apply_accounts",
    "job_apply_account_flows_macos",
    "job_apply_account_flows",
    "job_apply_credentials",
    "job_apply_credentials_macos",
    "job_apply_credentials_portable_runtime",
    "job_apply_account_executor",
    "job_apply_password_account_flows",
    "job_apply_account_canary_executor",
    "job_apply_trusted_fill",
    "job_apply_form_readiness",
    "job_apply_answer_match",
}


def _is_registry_name(name: str) -> bool:
    return name in _REGISTRY_NAMES or name == "qa" or name.startswith("qa.")


@lru_cache(maxsize=None)
def companion(name: str) -> Any:
    """Load one adjacent account contract without fixed-name import reuse."""

    if name not in _REGISTRY_NAMES:
        raise RuntimeError("account runtime dependency is unavailable")
    path = _SCRIPTS_ROOT / f"{name}.py"
    private_name = f"{_PACKAGE_NAME}.{name}"
    spec = importlib.util.spec_from_file_location(private_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("account runtime dependency is unavailable")
    module = importlib.util.module_from_spec(spec)
    saved_modules = {
        module_name: value
        for module_name, value in sys.modules.items()
        if _is_registry_name(module_name)
    }
    saved_path = list(sys.path)
    for module_name in tuple(sys.modules):
        if _is_registry_name(module_name):
            del sys.modules[module_name]
    scripts_root = str(_SCRIPTS_ROOT)
    plugin_root = str(_SCRIPTS_ROOT.parent)
    sys.path[:] = [
        scripts_root,
        plugin_root,
        *(entry for entry in saved_path if entry not in {scripts_root, plugin_root}),
    ]
    sys.modules[private_name] = module
    succeeded = False
    try:
        spec.loader.exec_module(module)
        module.__name__ = name
        succeeded = True
        return module
    finally:
        for module_name in tuple(sys.modules):
            if _is_registry_name(module_name):
                del sys.modules[module_name]
        sys.modules.update(saved_modules)
        if not succeeded:
            sys.modules.pop(private_name, None)
        sys.path[:] = saved_path


def validate_automation_settings(value: Any) -> dict[str, Any]:
    return _validate_settings(value, accounts_module=companion("job_apply_accounts"))


def validate_employer_account(key: str, value: Any) -> dict[str, Any]:
    return _validate_account(
        key,
        value,
        accounts_module=companion("job_apply_accounts"),
        credentials_module=companion("job_apply_credentials"),
    )


__all__ = [
    "_optional_email",
    "companion",
    "validate_automation_settings",
    "validate_employer_account",
]
