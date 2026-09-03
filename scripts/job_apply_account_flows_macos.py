#!/usr/bin/env python3
"""macOS Accessibility adapter for account-flow automation discovery."""

from __future__ import annotations

import json
import hashlib
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit


class MacOSAccessibilityAdapter:
    provider_id = "macos-accessibility"
    platform_prefixes = ("darwin",)

    def discover(self) -> dict[str, Any]:
        return {
            "providerId": self.provider_id,
            "state": "available",
            "emailOnlyCandidateProfileReady": True,
            "workdayPasswordAccountReady": True,
            "greenhouseAccountlessClassificationReady": True,
            "productionSeamReady": True,
            "liveExecutionEnabled": False,
            "credentialOperationsReady": False,
        }


class SyntheticMacOSAccessibilityProvider:
    """Test-only private identity consumer with value-free output."""

    provider_id = "macos-accessibility"

    def __init__(self, outcome: str = "active"):
        self.outcome = outcome
        self.effect_count = 0

    def execute_email_only(self, request: dict[str, Any], private_email: Callable[[], str]) -> dict[str, Any]:
        # The value is deliberately scoped to this method and never returned,
        # persisted, logged, serialized, or passed via process channels.
        identity = private_email()
        if not isinstance(identity, str) or "@" not in identity or len(identity) > 254:
            raise ValueError("canonical signup identity is unavailable")
        self.effect_count += 1
        del identity
        return {
            "providerId": self.provider_id,
            "outcome": self.outcome,
            "retryAllowed": False,
            "finalActionAuthorized": False,
            "emailRemoved": True,
            "termsAccepted": True,
            "nextActivations": 1,
            "credentialProviderInvocations": 0,
        }


class NativeMacOSAccessibilityProvider:
    """Compiled macOS Oracle boundary with private inherited-FD identity."""

    provider_id = "macos-accessibility"

    _constructor_token = object()
    _reviewed_sources = (
        "job_apply_credential_helper.swift",
        "job_apply_browser_bridge.swift",
        "job_apply_account_flow_helper.swift",
        "job_apply_credential_helper_tests.swift",
        "job_apply_credential_helper_main.swift",
    )
    _closed_failure_codes = {
        21: "request_binding", 22: "private_channel", 23: "effect",
        24: "email_effect", 25: "terms_effect", 26: "next_effect",
        27: "clearing_effect", 28: "request_binding_stage",
        29: "browser_binding", 30: "page_binding", 31: "control_binding",
        32: "state_binding", 33: "causal_binding", 34: "browser_process",
        36: "accessibility_trust", 37: "browser_activation",
        38: "browser_identity_process_executable",
        39: "browser_identity_running_application",
        40: "browser_identity_running_executable",
        41: "browser_identity_executable_match",
        42: "browser_identity_trusted_browser",
        43: "browser_identity_requirement",
        44: "browser_identity_static_code",
        45: "browser_identity_static_validity",
        46: "browser_identity_dynamic_code",
        47: "browser_identity_dynamic_validity",
    }

    def __init__(
        self, binary: str, browser_process_identifier: int, socket_path: str | None = None,
        *, _token: object | None = None, _digest: str | None = None,
        _device: int | None = None, _inode: int | None = None,
    ):
        if _token is not self._constructor_token:
            raise ValueError("native Oracle helper requires the reviewed source constructor")
        self.binary = binary
        self.browser_process_identifier = browser_process_identifier
        self.socket_path = socket_path
        self._digest = _digest
        self._device = _device
        self._inode = _inode

    @classmethod
    def from_reviewed_sources(
        cls, browser_process_identifier: int, socket_path: str | None = None,
        *, build_directory: str | os.PathLike[str] | None = None,
    ) -> "NativeMacOSAccessibilityProvider":
        """Build one exact reviewed helper set and pin this native session to it."""
        source_root = Path(__file__).resolve().parents[1] / "native" / "macos"
        sources = [source_root / name for name in cls._reviewed_sources]
        if any(not source.is_file() or source.is_symlink() for source in sources):
            raise ValueError("reviewed native Oracle sources are unavailable")
        if build_directory is None:
            build_root = Path(tempfile.mkdtemp(prefix="job-apply-reviewed-oracle-"))
        else:
            build_root = Path(build_directory).resolve()
            build_root.mkdir(parents=True, exist_ok=True)
        binary = build_root / "job-apply-reviewed-oracle-helper"
        completed = subprocess.run(
            ["/usr/bin/xcrun", "swiftc", "-O", "-o", str(binary), *(str(source) for source in sources)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=60, check=False,
        )
        if completed.returncode or not binary.is_file() or binary.is_symlink():
            raise ValueError("reviewed native Oracle helper build failed closed")
        stat = binary.stat()
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        return cls(
            str(binary), browser_process_identifier, socket_path,
            _token=cls._constructor_token, _digest=digest,
            _device=stat.st_dev, _inode=stat.st_ino,
        )

    def with_socket_path(self, socket_path: str) -> "NativeMacOSAccessibilityProvider":
        self._verified_binary()
        return type(self)(
            self.binary, self.browser_process_identifier, socket_path,
            _token=self._constructor_token, _digest=self._digest,
            _device=self._device, _inode=self._inode,
        )

    def _verified_binary(self) -> str:
        binary = os.path.realpath(self.binary)
        if os.path.islink(self.binary) or not os.path.isfile(binary):
            raise ValueError("native Oracle helper identity is invalid")
        stat = os.stat(binary, follow_symlinks=False)
        if (
            stat.st_dev != self._device or stat.st_ino != self._inode
            or hashlib.sha256(Path(binary).read_bytes()).hexdigest() != self._digest
        ):
            raise ValueError("native Oracle helper identity is invalid")
        signature = subprocess.run(
            ["/usr/bin/codesign", "--verify", "--strict", binary],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=5, check=False,
        )
        if signature.returncode:
            raise ValueError("native Oracle helper identity is invalid")
        return binary

    def prepare_email_only(self, portal_url: str, realm_ref: str, realm_descriptor: str) -> dict[str, Any]:
        """Inspect one exact visible Oracle form and return fingerprints only."""
        completed = subprocess.run([
            self._verified_binary(), "oracle-email-only-prepare", str(self.browser_process_identifier),
            portal_url, realm_ref, realm_descriptor,
        ], stdin=subprocess.DEVNULL, capture_output=True, timeout=10, check=False)
        if completed.returncode or completed.stderr or len(completed.stdout) > 4096:
            raise ValueError("native Oracle fingerprint preparation failed closed")
        try:
            result = json.loads(completed.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("native Oracle fingerprint preparation failed closed") from None
        expected = {
            "accountFormFingerprint", "emailControlFingerprint",
            "termsControlFingerprint", "termsDocumentFingerprint",
            "nextControlFingerprint", "accountCreationControlsFingerprint",
            "unknownRequiredControlsPresent", "credentialControlsPresent",
        }
        if (
            not isinstance(result, dict) or set(result) != expected
            or result["unknownRequiredControlsPresent"] is not False
            or result["credentialControlsPresent"] is not False
            or any(
                not isinstance(result[field], str)
                or len(result[field]) != 71 or not result[field].startswith("sha256:")
                or any(character not in "0123456789abcdef" for character in result[field][7:])
                for field in expected - {"unknownRequiredControlsPresent", "credentialControlsPresent"}
            )
        ):
            raise ValueError("native Oracle fingerprint preparation failed closed")
        return result

    @staticmethod
    def _read_attestation(listener: socket.socket, child_pid: int, operation: str) -> dict[str, Any]:
        listener.settimeout(10)
        channel, _ = listener.accept()
        try:
            channel.settimeout(5)
            peer = struct.unpack("i", channel.getsockopt(0, 2, struct.calcsize("i")))[0]
            if peer != child_pid:
                raise ValueError("native Oracle attestation peer is invalid")
            payload = b""
            while len(payload) <= 4096 and not payload.endswith(b"\n"):
                part = channel.recv(4097 - len(payload))
                if not part:
                    break
                payload += part
            if len(payload) > 4096 or not payload.endswith(b"\n"):
                raise ValueError("native Oracle attestation is invalid")
            value = json.loads(payload)
            expected = {
                "operationFingerprint", "nativeOriginAttested", "signedBrowserIdentityAttested",
                "emailFilledAttested", "termsAcceptedAttested", "nextActivatedExactlyOnce",
                "emailRemovedAttested", "finalActionActivated",
                "credentialProviderInvocations", "outcome",
            }
            if (
                not isinstance(value, dict) or set(value) != expected
                or value["operationFingerprint"] != operation
                or value["nativeOriginAttested"] is not True
                or value["signedBrowserIdentityAttested"] is not True
                or value["emailFilledAttested"] is not True
                or value["termsAcceptedAttested"] is not True
                or value["nextActivatedExactlyOnce"] is not True
                or value["emailRemovedAttested"] is not True
                or value["finalActionActivated"] is not False
                or value["credentialProviderInvocations"] != 0
                or value["outcome"] not in {"active", "verification_required", "failed_definitive", "ambiguous"}
            ):
                raise ValueError("native Oracle attestation is invalid")
            channel.sendall(b"\x01")
            return value
        finally:
            channel.close()

    def execute_email_only(self, request: dict[str, Any], private_email: Callable[[], str]) -> dict[str, Any]:
        binary = self._verified_binary()
        portal = urlsplit(request["portalUrl"])
        operation = (request.get("operationFingerprint") or ("sha256:" + portal.query.removeprefix("operation=")))
        operation_hex = operation.removeprefix("sha256:")
        if len(operation_hex) != 64 or any(character not in "0123456789abcdef" for character in operation_hex):
            raise ValueError("native Oracle operation binding is invalid")
        socket_root = None
        listener = None
        socket_path = self.socket_path
        if portal.scheme == "https":
            socket_root = tempfile.mkdtemp(prefix="job-apply-oracle-")
            socket_path = os.path.join(socket_root, "attestation.sock")
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(socket_path); os.chmod(socket_path, 0o600); listener.listen(1)
        if not socket_path:
            raise ValueError("native Oracle attestation channel is unavailable")
        read_descriptor, write_descriptor = os.pipe()
        try:
            child = subprocess.Popen([
                binary, "oracle-email-only", str(self.browser_process_identifier),
                request["portalUrl"], request["realmRef"], request["realmDescriptor"],
                request["accountFormFingerprint"], request["emailControlFingerprint"],
                request["termsControlFingerprint"], request["termsDocumentFingerprint"],
                request["nextControlFingerprint"], request["accountCreationControlsFingerprint"],
                str(request["jobRevision"]), str(request["accountRevision"]),
                str(request["settingsRevision"]), operation,
                socket_path, str(read_descriptor),
            ], pass_fds=(read_descriptor,), stdin=subprocess.DEVNULL,
               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            os.close(read_descriptor); read_descriptor = -1
            identity = private_email()
            if not isinstance(identity, str) or "@" not in identity or len(identity) > 254:
                child.kill(); child.wait(timeout=2)
                raise ValueError("canonical signup identity is unavailable")
            try:
                os.write(write_descriptor, identity.encode("utf-8"))
            finally:
                identity = ""
                os.close(write_descriptor); write_descriptor = -1
            attestation = self._read_attestation(listener, child.pid, operation) if listener is not None else None
            stdout, stderr = child.communicate(timeout=30)
            if child.returncode or stdout or stderr:
                diagnostic = self._closed_failure_codes.get(child.returncode, "unclassified")
                raise ValueError(f"native Oracle account flow failed closed ({diagnostic})")
            if attestation is None:
                observation_url = f"http://127.0.0.1:{portal.port}/observations/by-operation/{operation_hex}"
                with urllib.request.urlopen(observation_url, timeout=2) as response:
                    observation = json.loads(response.read())
            else:
                observation = {
                    "lifecycleState": attestation["outcome"], "retryAllowed": False,
                    "finalActionAuthorized": False, "emailRemoved": True,
                    "termsAccepted": True, "nextActivations": 1,
                    "credentialProviderInvocations": 0,
                }
            return {
                "providerId": self.provider_id,
                "outcome": observation["lifecycleState"],
                "retryAllowed": observation["retryAllowed"],
                "finalActionAuthorized": observation["finalActionAuthorized"],
                "emailRemoved": observation["emailRemoved"],
                "termsAccepted": observation["termsAccepted"],
                "nextActivations": observation["nextActivations"],
                "credentialProviderInvocations": observation["credentialProviderInvocations"],
            }
        finally:
            if "child" in locals() and child.poll() is None:
                child.kill()
                child.wait(timeout=2)
            if read_descriptor >= 0:
                os.close(read_descriptor)
            if write_descriptor >= 0:
                os.close(write_descriptor)
            if listener is not None:
                listener.close()
            if socket_root is not None:
                shutil.rmtree(socket_root, ignore_errors=True)


ADAPTER_REGISTRY = (MacOSAccessibilityAdapter(),)
