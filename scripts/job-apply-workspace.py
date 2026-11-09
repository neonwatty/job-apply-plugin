#!/usr/bin/env python3
"""Secure loopback companion workspace for canonical Job Apply records."""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import secrets
import sys
import webbrowser
from pathlib import Path
from typing import Any


def load_store_module() -> Any:
    path = Path(__file__).resolve().with_name("job-apply-store.py")
    name = "_job_apply_workspace_store_" + hashlib.sha256(
        str(path).encode("utf-8")
    ).hexdigest()
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load the canonical Job Apply store")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE_MODULE = load_store_module()

_IMPLEMENTATION_ROOT = Path(__file__).with_name("job_apply_workspace").resolve()
_PACKAGE_NAME = "_job_apply_workspace_parts_" + hashlib.sha256(
    str(_IMPLEMENTATION_ROOT).encode("utf-8")
).hexdigest()


def _load_implementation_package() -> Any:
    for name in tuple(sys.modules):
        if name == _PACKAGE_NAME or name.startswith(_PACKAGE_NAME + "."):
            del sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        _PACKAGE_NAME,
        _IMPLEMENTATION_ROOT / "__init__.py",
        submodule_search_locations=[str(_IMPLEMENTATION_ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("workspace implementation is unavailable")
    package = importlib.util.module_from_spec(spec)
    sys.modules[_PACKAGE_NAME] = package
    try:
        spec.loader.exec_module(package)
    except BaseException:
        for name in tuple(sys.modules):
            if name == _PACKAGE_NAME or name.startswith(_PACKAGE_NAME + "."):
                del sys.modules[name]
        raise
    return package


_implementation = _load_implementation_package()
_implementation.bind_runtime(lambda: globals())
_projections = importlib.import_module(f"{_PACKAGE_NAME}.projections")
_handler = importlib.import_module(f"{_PACKAGE_NAME}.handler")
_cli = importlib.import_module(f"{_PACKAGE_NAME}.cli")

LOOPBACK = _implementation.LOOPBACK
MAX_BODY_BYTES = _implementation.MAX_BODY_BYTES
MAX_UPLOAD_BYTES = _implementation.MAX_UPLOAD_BYTES
MAX_UPLOAD_BODY_BYTES = _implementation.MAX_UPLOAD_BODY_BYTES
MAX_BULK_URLS = _implementation.MAX_BULK_URLS
ROOT = _implementation.ROOT
ASSET_ROOT = _implementation.ASSET_ROOT
ASSETS = _implementation.ASSETS
loopback_authority = _implementation.loopback_authority

public_resume = _projections.public_resume
public_resumes = _projections.public_resumes
public_extraction_request = _projections.public_extraction_request
resume_projection = _projections.resume_projection
unified_trash_projection = _projections.unified_trash_projection
public_proposal_summary = _projections.public_proposal_summary
public_proposal_detail = _projections.public_proposal_detail

degraded_boot_status = _handler.degraded_boot_status
WorkspaceServer = _handler.WorkspaceServer
WorkspaceHandler = _handler.WorkspaceHandler
build_parser = _cli.build_parser
main = _cli.main


if __name__ == "__main__":
    raise SystemExit(main())
