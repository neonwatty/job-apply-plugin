#!/usr/bin/env python3
"""Reviewed macOS adapter for the portable Workday account-flow contract."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable


def _contract_module():
    path = Path(__file__).with_name("job_apply_password_account_flows.py")
    spec = importlib.util.spec_from_file_location("job_apply_password_account_flows_native", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


CONTRACT = _contract_module()


class NativeMacOSWorkdayAccountProvider:
    """Digest-pinned native helper; no secret crosses its process arguments."""

    provider_id = "macos-workday-account"
    _constructor_token = object()
    _reviewed_sources = (
        "job_apply_credential_helper.swift", "job_apply_browser_bridge.swift",
        "job_apply_account_flow_helper.swift", "job_apply_workday_account_flow_helper.swift",
        "job_apply_credential_helper_tests.swift", "job_apply_credential_helper_main.swift",
    )

    def __init__(self, binary: str, browser_process_identifier: int, socket_path: str | None = None,
                 *, _token: object | None = None, _digest: str | None = None,
                 _device: int | None = None, _inode: int | None = None):
        if _token is not self._constructor_token:
            raise ValueError("native Workday helper requires the reviewed source constructor")
        self.binary, self.browser_process_identifier, self.socket_path = binary, browser_process_identifier, socket_path
        self._digest, self._device, self._inode = _digest, _device, _inode

    @classmethod
    def from_reviewed_sources(cls, browser_process_identifier: int, socket_path: str | None = None,
                              *, build_directory: str | os.PathLike[str] | None = None):
        source_root = Path(__file__).resolve().parents[1] / "native" / "macos"
        sources = [source_root / name for name in cls._reviewed_sources]
        if any(not source.is_file() or source.is_symlink() for source in sources):
            raise ValueError("reviewed native Workday sources are unavailable")
        build_root = Path(build_directory).resolve() if build_directory is not None else Path(tempfile.mkdtemp(prefix="job-apply-reviewed-workday-"))
        build_root.mkdir(parents=True, exist_ok=True)
        binary = build_root / "job-apply-reviewed-workday-helper"
        completed = subprocess.run(
            ["/usr/bin/xcrun", "swiftc", "-O", "-o", str(binary), *(str(source) for source in sources)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False,
        )
        if completed.returncode or not binary.is_file() or binary.is_symlink():
            raise ValueError("reviewed native Workday helper build failed closed")
        stat = binary.stat()
        return cls(str(binary), browser_process_identifier, socket_path, _token=cls._constructor_token,
                   _digest=hashlib.sha256(binary.read_bytes()).hexdigest(), _device=stat.st_dev, _inode=stat.st_ino)

    def _verified_binary(self) -> str:
        binary = os.path.realpath(self.binary)
        if os.path.islink(self.binary) or not os.path.isfile(binary):
            raise ValueError("native Workday helper identity is invalid")
        stat = os.stat(binary, follow_symlinks=False)
        if stat.st_dev != self._device or stat.st_ino != self._inode or hashlib.sha256(Path(binary).read_bytes()).hexdigest() != self._digest:
            raise ValueError("native Workday helper identity is invalid")
        signature = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", binary], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        if signature.returncode:
            raise ValueError("native Workday helper identity is invalid")
        return binary

    def run_adversarial_fixtures(self) -> dict[str, Any]:
        completed = subprocess.run([self._verified_binary(), "workday-account-adversarial-fixtures"],
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=10, check=False)
        if completed.returncode or completed.stdout or completed.stderr:
            raise ValueError("native Workday adversarial fixtures failed closed")
        return {"passed": True, "effectCount": 0}

    def prepare(self, request: dict[str, Any]) -> dict[str, Any]:
        exact = CONTRACT.validate_password_preparation_request(request)
        completed = subprocess.run([self._verified_binary(), "workday-prepare", str(self.browser_process_identifier),
                                    exact["portalUrl"], exact["realmRef"], exact["realmDescriptor"]],
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=10, check=False)
        if completed.returncode or completed.stderr or len(completed.stdout) > 4096:
            raise ValueError("native Workday preparation failed closed")
        try:
            return CONTRACT.validate_password_preparation_receipt(json.loads(completed.stdout), self.provider_id)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise ValueError("native Workday preparation failed closed") from None

    @staticmethod
    def _read_receipt(listener: socket.socket, child_pid: int) -> dict[str, Any]:
        listener.settimeout(10)
        channel, _ = listener.accept()
        try:
            peer = struct.unpack("i", channel.getsockopt(0, 2, struct.calcsize("i")))[0]
            if peer != child_pid:
                raise ValueError("native Workday attestation peer is invalid")
            payload = b""
            while len(payload) <= 4096 and not payload.endswith(b"\n"):
                part = channel.recv(4097 - len(payload))
                if not part: break
                payload += part
            if len(payload) > 4096 or not payload.endswith(b"\n"):
                raise ValueError("native Workday attestation is invalid")
            value = json.loads(payload); channel.sendall(b"\x01")
            return value
        finally:
            channel.close()

    def execute(self, request: dict[str, Any], private_email: Callable[[], str]) -> dict[str, Any]:
        exact = CONTRACT.validate_password_execution_request(request)
        binary = self._verified_binary()
        socket_root = tempfile.mkdtemp(prefix="job-apply-workday-")
        socket_path = self.socket_path or os.path.join(socket_root, "attestation.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(socket_path); os.chmod(socket_path, 0o600); listener.listen(1)
        read_descriptor, write_descriptor = os.pipe(); child = None
        try:
            child = subprocess.Popen([binary, "workday-account", str(self.browser_process_identifier), exact["portalUrl"],
                exact["realmRef"], exact["realmDescriptor"], exact["accountFormFingerprint"], exact["emailControlFingerprint"],
                exact["passwordControlFingerprint"], exact["createAccountControlFingerprint"],
                exact["accountCreationControlsFingerprint"], socket_path, str(read_descriptor)],
                pass_fds=(read_descriptor,), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            os.close(read_descriptor); read_descriptor = -1
            identity = private_email()
            if not isinstance(identity, str) or "@" not in identity or len(identity) > 254:
                raise ValueError("canonical signup identity is unavailable")
            try: os.write(write_descriptor, identity.encode("utf-8"))
            finally: identity = ""; os.close(write_descriptor); write_descriptor = -1
            receipt = self._read_receipt(listener, child.pid)
            stdout, stderr = child.communicate(timeout=15)
            if child.returncode or stdout or stderr:
                raise ValueError("native Workday account flow failed closed")
            return CONTRACT.validate_password_receipt(receipt, self.provider_id)
        finally:
            if child is not None and child.poll() is None: child.kill(); child.wait(timeout=2)
            if read_descriptor >= 0: os.close(read_descriptor)
            if write_descriptor >= 0: os.close(write_descriptor)
            listener.close(); shutil.rmtree(socket_root, ignore_errors=True)
