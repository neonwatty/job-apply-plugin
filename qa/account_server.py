#!/usr/bin/env python3
"""Loopback-only visible synthetic account portal; it accepts no submissions."""

from __future__ import annotations

import json
import hashlib
import ctypes
import os
import socket
import struct
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


ASSETS = Path(__file__).with_name("account_renderer")


class SyntheticAccountHandler(BaseHTTPRequestHandler):
    server_version = "JobApplySyntheticAccount/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/synthetic-account/") or path.startswith("/synthetic-oracle/"):
            self.send_error(404); return
        if path in {"/synthetic-account", "/synthetic-oracle"}:
            query = parse_qs(urlsplit(self.path).query, strict_parsing=True)
            operation = query.get("operation", [""])[0]
            if set(query) != {"operation"} or len(query["operation"]) != 1 or len(operation) != 64:
                self.send_error(400); return
            if not self.server.operation_is_registered(operation):
                self.send_error(404); return
            template = (ASSETS / "index.html").read_text(encoding="utf-8")
            mode = "oracle-email-only" if path == "/synthetic-oracle" else "password-account"
            body = template.replace("__OPERATION__", "sha256:" + operation).replace("__ACCOUNT_MODE__", mode).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers(); self.wfile.write(body)
            return
        asset = {"/app.js": "app.js", "/styles.css": "styles.css"}.get(path)
        if asset:
            body = (ASSETS / asset).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript" if asset.endswith(".js") else "text/css")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers(); self.wfile.write(body)
            return
        if path == "/state":
            body = json.dumps({"synthetic": True, "submissionAccepted": False}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        if path.startswith("/observations/by-operation/"):
            operation = path.rsplit("/", 1)[-1]
            observation = self.server.consume_observation(operation)
            if observation is None:
                self.send_error(404); return
            body = json.dumps(observation, sort_keys=True).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store")
            self.end_headers(); self.wfile.write(body); return
        self.send_error(404)

    def do_POST(self) -> None:
        self.send_response(405)
        self.send_header("Content-Length", "0")
        self.end_headers()


class SyntheticAccountServer(ThreadingHTTPServer):
    allow_reuse_address = True

    # The synthetic portal owns this immutable transition schedule. Neither a
    # URL, request packet, DOM label, nor harness argument can select a state.
    _PORTAL_TRANSITIONS = (
        "success", "reuse", "verification", "challenge", "consent", "reset",
        "definitive_failure", "ambiguity",
    )

    def __init__(self, port: int = 0, *, native_helper_path: str | Path | None = None):
        self._observations = {}
        self._registrations: dict[str, tuple[int, str]] = {}
        self._registration_lock = threading.Lock()
        self._registration_generation = 0
        self._transition_index = 0
        self._oracle_transition_index = 0
        self._native_identity = self._signed_identity(native_helper_path) if native_helper_path else None
        self._socket_roots: set[str] = set()
        super().__init__(("127.0.0.1", port), SyntheticAccountHandler)

    @staticmethod
    def _signed_identity(path: str | Path) -> tuple[str, str, str]:
        resolved = str(Path(path).resolve(strict=True))
        verified = subprocess.run(
            ["/usr/bin/codesign", "--verify", "--strict", "--all-architectures", resolved],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        details = subprocess.run(
            ["/usr/bin/codesign", "-dvvv", resolved], capture_output=True, text=True, check=False,
        )
        metadata = details.stderr + details.stdout
        identifier = next((line.split("=", 1)[1] for line in metadata.splitlines() if line.startswith("Identifier=")), "")
        cdhash = next((line.split("=", 1)[1] for line in metadata.splitlines() if line.startswith("CDHash=")), "")
        if verified.returncode or details.returncode or not identifier or len(cdhash) != 40:
            raise ValueError("native helper signed identity is unavailable")
        return resolved, identifier, cdhash.upper()

    @classmethod
    def _dynamic_signed_identity(cls, pid: int) -> tuple[str, str, str]:
        """Read the identity of the running peer, rather than its path on disk."""
        security = ctypes.CDLL(
            "/System/Library/Frameworks/Security.framework/Versions/A/Security"
        )
        core = ctypes.CDLL(
            "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation"
        )

        core.CFNumberCreate.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.c_void_p]
        core.CFNumberCreate.restype = ctypes.c_void_p
        core.CFDictionaryCreate.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_void_p), ctypes.c_long,
            ctypes.c_void_p, ctypes.c_void_p,
        ]
        core.CFDictionaryCreate.restype = ctypes.c_void_p
        core.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        core.CFDictionaryGetValue.restype = ctypes.c_void_p
        core.CFStringGetCString.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_uint32,
        ]
        core.CFStringGetCString.restype = ctypes.c_bool
        core.CFDataGetLength.argtypes = [ctypes.c_void_p]
        core.CFDataGetLength.restype = ctypes.c_long
        core.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
        core.CFDataGetBytePtr.restype = ctypes.POINTER(ctypes.c_ubyte)
        core.CFRelease.argtypes = [ctypes.c_void_p]

        security.SecCodeCopyGuestWithAttributes.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        security.SecCodeCopyGuestWithAttributes.restype = ctypes.c_int32
        security.SecCodeCheckValidity.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p,
        ]
        security.SecCodeCheckValidity.restype = ctypes.c_int32
        security.SecCodeCopySigningInformation.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p),
        ]
        security.SecCodeCopySigningInformation.restype = ctypes.c_int32

        def security_constant(name: str) -> int:
            value = ctypes.c_void_p.in_dll(security, name).value
            if not value:
                raise ValueError("native peer security metadata is unavailable")
            return value

        pid_number = None
        attributes = None
        peer_code = ctypes.c_void_p()
        signing_information = ctypes.c_void_p()
        try:
            raw_pid = ctypes.c_int32(pid)
            # kCFNumberSInt32Type is stable CoreFoundation ABI value 3.
            pid_number = core.CFNumberCreate(None, 3, ctypes.byref(raw_pid))
            if not pid_number:
                raise ValueError("native peer pid metadata is unavailable")
            keys = (ctypes.c_void_p * 1)(security_constant("kSecGuestAttributePid"))
            values = (ctypes.c_void_p * 1)(pid_number)
            attributes = core.CFDictionaryCreate(None, keys, values, 1, None, None)
            if not attributes:
                raise ValueError("native peer attributes are unavailable")
            if security.SecCodeCopyGuestWithAttributes(
                None, attributes, 0, ctypes.byref(peer_code)
            ) != 0 or not peer_code.value:
                raise ValueError("native peer dynamic code is unavailable")
            if security.SecCodeCheckValidity(peer_code, 0, None) != 0:
                raise ValueError("native peer dynamic code is invalid")
            # kSecCSSigningInformation is stable Security.framework flag 1 << 1.
            if security.SecCodeCopySigningInformation(
                peer_code, 1 << 1, ctypes.byref(signing_information)
            ) != 0 or not signing_information.value:
                raise ValueError("native peer signing information is unavailable")

            identifier_ref = core.CFDictionaryGetValue(
                signing_information, security_constant("kSecCodeInfoIdentifier")
            )
            unique_ref = core.CFDictionaryGetValue(
                signing_information, security_constant("kSecCodeInfoUnique")
            )
            if not identifier_ref or not unique_ref:
                raise ValueError("native peer signed identity is unavailable")
            identifier_buffer = ctypes.create_string_buffer(4096)
            if not core.CFStringGetCString(
                identifier_ref, identifier_buffer, len(identifier_buffer), 0x08000100
            ):
                raise ValueError("native peer identifier is unavailable")
            length = core.CFDataGetLength(unique_ref)
            byte_pointer = core.CFDataGetBytePtr(unique_ref)
            if length != 20 or not byte_pointer:
                raise ValueError("native peer CDHash is unavailable")
            cdhash = bytes(byte_pointer[index] for index in range(length)).hex().upper()
            return cls._process_path(pid), identifier_buffer.value.decode("utf-8"), cdhash
        finally:
            if signing_information.value:
                core.CFRelease(signing_information)
            if peer_code.value:
                core.CFRelease(peer_code)
            if attributes:
                core.CFRelease(attributes)
            if pid_number:
                core.CFRelease(pid_number)

    @staticmethod
    def _peer_pid(channel: socket.socket) -> int:
        # macOS LOCAL_PEERPID. Numeric constants are stable Darwin ABI values
        # but are not exposed by Python's socket module.
        raw = channel.getsockopt(0, 2, struct.calcsize("i"))
        return struct.unpack("i", raw)[0]

    @staticmethod
    def _process_path(pid: int) -> str:
        library = ctypes.CDLL("/usr/lib/libproc.dylib")
        buffer = ctypes.create_string_buffer(4096)
        count = library.proc_pidpath(ctypes.c_int(pid), buffer, ctypes.c_uint32(len(buffer)))
        if count <= 0:
            raise ValueError("native peer executable is unavailable")
        return str(Path(os.fsdecode(buffer.value)).resolve(strict=True))

    def _peer_is_exact_native_helper(self, channel: socket.socket) -> bool:
        if self._native_identity is None:
            return False
        try:
            pid = self._peer_pid(channel)
            path = self._process_path(pid)
            return (
                path == self._native_identity[0]
                and self._signed_identity(path) == self._native_identity
                and self._dynamic_signed_identity(pid) == self._native_identity
            )
        except (OSError, ValueError):
            return False

    def record_observation(self, token: str, observation: dict) -> None:
        self._observations[token] = observation

    def consume_observation(self, token: str):
        return self._observations.pop(token, None)

    def prepare_native_operation(self, operation: str, *, mode: str = "password-account") -> str:
        if len(operation) != 64 or any(character not in "0123456789abcdef" for character in operation):
            raise ValueError("synthetic native operation is invalid")
        if mode not in {"password-account", "oracle-email-only"}:
            raise ValueError("synthetic native operation mode is invalid")
        socket_root = tempfile.mkdtemp(prefix="job-apply-native-")
        socket_path = os.path.join(socket_root, "attestation.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(socket_path)
        os.chmod(socket_path, 0o600)
        listener.listen(1)
        with self._registration_lock:
            if operation in self._registrations:
                listener.close(); os.unlink(socket_path); os.rmdir(socket_root)
                raise ValueError("synthetic native operation already exists")
            self._registration_generation += 1
            generation = self._registration_generation
            self._registrations[operation] = (generation, mode)
            self._socket_roots.add(socket_root)
        threading.Thread(
            target=self._receive_native_attestation,
            args=(listener, operation, generation, socket_path, socket_root), daemon=True,
        ).start()
        return socket_path

    def operation_is_registered(self, operation: str) -> bool:
        with self._registration_lock:
            return operation in self._registrations

    def _retire_native_operation(self, operation: str, generation: int) -> bool:
        """Retire only the registration generation owned by one listener."""
        with self._registration_lock:
            registered = self._registrations.get(operation)
            if registered is None or registered[0] != generation:
                return False
            del self._registrations[operation]
            return True

    def _receive_native_attestation(self, listener: socket.socket, operation: str, generation: int, socket_path: str, socket_root: str) -> None:
        channel = None
        try:
            listener.settimeout(5)
            channel, _ = listener.accept()
            channel.settimeout(5)
            if not self._peer_is_exact_native_helper(channel):
                return
            payload = b""
            while len(payload) <= 2048 and not payload.endswith(b"\n"):
                part = channel.recv(2049 - len(payload))
                if not part:
                    return
                payload += part
            if len(payload) > 2048 or not payload.endswith(b"\n"):
                return
            attestation = json.loads(payload)
            with self._registration_lock:
                registered = self._registrations.get(operation)
                mode = registered[1] if registered is not None and registered[0] == generation else None
            expected = ({
                "operationFingerprint": "sha256:" + operation,
                "nativeOriginAttested": True,
                "signedBrowserIdentityAttested": True,
                "beforeFillAttested": True,
                "duringFillAttested": True,
                "afterClearAttested": True,
                "secureControlCleared": True,
            } if mode == "password-account" else {
                "operationFingerprint": "sha256:" + operation,
                "nativeOriginAttested": True,
                "signedBrowserIdentityAttested": True,
                "emailFilledAttested": True,
                "termsAcceptedAttested": True,
                "nextActivatedExactlyOnce": True,
                "emailRemovedAttested": True,
                "finalActionActivated": False,
                "credentialProviderInvocations": 0,
            })
            if attestation != expected:
                return
            with self._registration_lock:
                if mode == "oracle-email-only":
                    transitions = ("success", "verification", "definitive_failure", "ambiguity")
                    if self._oracle_transition_index >= len(transitions):
                        return
                    portal_state = transitions[self._oracle_transition_index]
                    self._oracle_transition_index += 1
                else:
                    if self._transition_index >= len(self._PORTAL_TRANSITIONS):
                        return
                    portal_state = self._PORTAL_TRANSITIONS[self._transition_index]
                    self._transition_index += 1
            lifecycle = {
                "success": "active", "reuse": "active", "verification": "verification_required",
                "challenge": "verification_required", "consent": "verification_required",
                "reset": "reset_required", "definitive_failure": "failed_definitive",
                "ambiguity": "ambiguous",
            }[portal_state]
            digest = lambda value: "sha256:" + hashlib.sha256(value.encode()).hexdigest()
            observation = {
                "portalState": portal_state, "lifecycleState": lifecycle,
                "formFingerprint": digest("account-form:v2"),
                "controlFingerprint": digest("account-controls:v2"),
            }
            if mode == "oracle-email-only":
                observation.update({
                    "retryAllowed": False, "finalActionAuthorized": False,
                    "emailRemoved": True, "termsAccepted": True,
                    "nextActivations": 1, "credentialProviderInvocations": 0,
                })
            self.record_observation(operation, observation)
            # A repeated scenario can intentionally reuse the same operation
            # fingerprint. Retire the completed registration before the causal
            # acknowledgment releases the helper to prepare that next run.
            self._retire_native_operation(operation, generation)
            channel.sendall(b"\x01")
        except (OSError, ValueError, json.JSONDecodeError):
            return
        finally:
            if channel is not None:
                channel.close()
            listener.close()
            self._retire_native_operation(operation, generation)
            with self._registration_lock:
                self._socket_roots.discard(socket_root)
            try:
                os.unlink(socket_path)
            except FileNotFoundError:
                pass
            try:
                os.rmdir(socket_root)
            except OSError:
                pass
