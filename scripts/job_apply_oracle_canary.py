#!/usr/bin/env python3
"""Private exact-source constructor for one reviewed Oracle canary session.

This module intentionally accepts no helper path or provider override.  The
native helper is built from the repository's closed reviewed source set and the
returned provider pins that exact file identity for preparation and execution.
"""

from __future__ import annotations

import importlib.util
from datetime import datetime
from pathlib import Path
from typing import Any


def _sibling(name: str):
    spec = importlib.util.spec_from_file_location(
        f"job_apply_oracle_canary_{name}", Path(__file__).with_name(f"{name}.py")
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("private Oracle canary boundary is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MACOS = _sibling("job_apply_account_flows_macos")
EXECUTOR = _sibling("job_apply_account_canary_executor")


class PrivateOracleCanarySession:
    """One browser-bound, exact reviewed-helper session."""

    __slots__ = ("_provider", "_executor", "_authority", "_store")

    def __init__(self, provider: Any, executor: Any, authority: Any, store: Any):
        self._provider = provider
        self._executor = executor
        self._authority = authority
        self._store = store

    def prepare(
        self, portal_url: str, realm_ref: str, realm_descriptor: str, *,
        portal_name: str, preparation_scope: dict[str, Any],
        preparation_approval_ref: str,
    ) -> dict[str, Any]:
        """Consume exact durable read-only approval before opening the page."""
        self._store.revalidate_live_email_only_preparation_scope(
            preparation_scope, portal_url, portal_name, realm_descriptor,
        )
        self._authority.authorize_preparation(
            preparation_scope, preparation_approval_ref,
        )
        return self._provider.prepare_email_only(portal_url, realm_ref, realm_descriptor)

    def execute(self, request: dict[str, Any], *, now: datetime) -> dict[str, Any]:
        return self._executor.execute(request, now=now)

    def execute_approved(
        self, request: dict[str, Any], approval_ref: str, *,
        owner_label: str, now: datetime,
    ) -> dict[str, Any]:
        """Acquire/recover and consume short-lived authority immediately."""
        return self._executor.execute_approved(
            request, approval_ref, owner_label=owner_label, now=now,
        )


def create_private_oracle_canary_session(
    authority: Any, store: Any, browser_process_identifier: int,
    *, build_directory: str | None = None,
) -> PrivateOracleCanarySession:
    """Construct the only production Oracle session; no binary override exists."""
    if not isinstance(browser_process_identifier, int) or isinstance(browser_process_identifier, bool):
        raise ValueError("private Oracle browser identity is invalid")
    provider = MACOS.NativeMacOSAccessibilityProvider.from_reviewed_sources(
        browser_process_identifier, build_directory=build_directory,
    )
    return PrivateOracleCanarySession(
        provider, EXECUTOR.LiveAccountCanaryExecutor(authority, store, provider),
        authority, store,
    )
