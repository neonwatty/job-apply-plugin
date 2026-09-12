#!/usr/bin/env python3
"""Launch the reviewed native shared-credential setup boundary on macOS."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable


def _credentials_module():
    name = "job_apply_shared_credentials_portable_runtime"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).with_name("job_apply_credentials.py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


CREDENTIALS = _credentials_module()
_REALM_SENTINEL = "0" * 64
_SOURCES = (
    "job_apply_credential_helper.swift",
    "job_apply_shared_credential_setup.swift",
    "job_apply_shared_credential_setup_main.swift",
)


class SharedCredentialSetupError(ValueError):
    """A value-free native shared-credential setup failure."""


def _validate_request(action: str, source: str, credential_version: int | None) -> int:
    if source not in {"generate", "enter"}:
        raise SharedCredentialSetupError("shared credential source is invalid")
    if action == "setup" and credential_version is None:
        return 1
    if (
        action == "rotate"
        and isinstance(credential_version, int)
        and not isinstance(credential_version, bool)
        and credential_version >= 2
    ):
        return credential_version
    raise SharedCredentialSetupError("shared credential version is invalid")


def _validate_receipt(value: Any, version: int) -> dict[str, Any]:
    expected = {
        "credentialRef": CREDENTIALS.credential_reference("shared", _REALM_SENTINEL, version),
        "credentialVersion": version,
        "status": "created",
    }
    if value != expected:
        raise SharedCredentialSetupError("native shared credential receipt is invalid")
    return value


def _run_reviewed_native(request: dict[str, Any]) -> dict[str, Any]:
    if not sys.platform.startswith("darwin"):
        raise SharedCredentialSetupError("native shared credential setup requires macOS")
    source_root = Path(__file__).resolve().parents[1] / "native" / "macos"
    sources = [source_root / name for name in _SOURCES]
    if any(not source.is_file() or source.is_symlink() for source in sources):
        raise SharedCredentialSetupError("reviewed native shared credential sources are unavailable")
    with tempfile.TemporaryDirectory(prefix="job-apply-shared-credential-") as directory:
        binary = Path(directory) / "job-apply-shared-credential"
        completed = subprocess.run(
            ["/usr/bin/xcrun", "swiftc", "-O", "-o", str(binary), *(str(source) for source in sources)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=60, check=False,
        )
        if completed.returncode or not binary.is_file() or binary.is_symlink():
            raise SharedCredentialSetupError("reviewed native shared credential build failed closed")
        before = binary.stat()
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        command = [str(binary), request["action"], request["source"]]
        if request["action"] == "rotate":
            command.append(str(request["credentialVersion"]))
        current = binary.stat()
        if (
            (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
            or hashlib.sha256(binary.read_bytes()).hexdigest() != digest
        ):
            raise SharedCredentialSetupError("reviewed native shared credential identity is invalid")
        result = subprocess.run(
            command, stdin=subprocess.DEVNULL, capture_output=True, timeout=300, check=False,
            env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        )
    if result.returncode == 64 and not result.stdout and not result.stderr:
        raise SharedCredentialSetupError("native shared credential setup was cancelled")
    if result.returncode == 65 and not result.stdout and not result.stderr:
        raise SharedCredentialSetupError("shared credential version already exists")
    if result.returncode or result.stderr or len(result.stdout) > 4096:
        raise SharedCredentialSetupError("native shared credential setup failed closed")
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SharedCredentialSetupError("native shared credential receipt is invalid") from None
    return value


class MacOSSharedCredentialSetup:
    """Version-safe setup facade whose bridge can carry metadata only."""

    def __init__(self, bridge: Callable[[dict[str, Any]], dict[str, Any]] | None = None):
        self._bridge = bridge or _run_reviewed_native

    def create(
        self, action: str, source: str, credential_version: int | None = None
    ) -> dict[str, Any]:
        version = _validate_request(action, source, credential_version)
        request = {"action": action, "source": source, "credentialVersion": version}
        return _validate_receipt(self._bridge(request), version)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Save a shared password in the native macOS Keychain")
    subparsers = parser.add_subparsers(dest="action", required=True)
    setup = subparsers.add_parser("setup")
    setup.add_argument("--source", choices=("generate", "enter"), required=True)
    rotate = subparsers.add_parser("rotate")
    rotate.add_argument("--source", choices=("generate", "enter"), required=True)
    rotate.add_argument("--credential-version", type=int, required=True)
    args = parser.parse_args(argv)
    try:
        receipt = MacOSSharedCredentialSetup().create(
            args.action, args.source, getattr(args, "credential_version", None)
        )
    except SharedCredentialSetupError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
