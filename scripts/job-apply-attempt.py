#!/usr/bin/env python3
"""Detached, Store-scoped broker for one canonical application attempt."""

from __future__ import annotations

import argparse
import errno
import hashlib
import importlib.util
import json
import os
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

HEARTBEAT_SECONDS = 60.0
STARTUP_SECONDS = 10.0
IDLE_SECONDS = 10.0
PID_NAME = ".job-apply-attempt.pid"
MAX_REQUEST_BYTES = 1024 * 1024


def load_store_module() -> Any:
    path = Path(__file__).resolve().with_name("job-apply-store.py")
    spec = importlib.util.spec_from_file_location("job_apply_attempt_store", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("canonical store unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE: Any | None = None


def store_module() -> Any:
    global STORE
    if STORE is None:
        STORE = load_store_module()
    return STORE


class InvalidInvocation(ValueError):
    """A public command or argument is outside the closed client surface."""


class AttemptParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        raise InvalidInvocation("invalid invocation")


def build_parser() -> argparse.ArgumentParser:
    parser = AttemptParser(description=__doc__)
    parser.add_argument("--root")
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start")
    start.add_argument("--id", required=True)
    start.add_argument("--owner", required=True)
    start.add_argument("--expected-revision", required=True, type=int)
    commands.add_parser("heartbeat")
    progress = commands.add_parser("progress")
    progress.add_argument("--input", required=True)
    handoff = commands.add_parser("handoff")
    handoff.add_argument("--status", required=True, choices=("needs_info", "awaiting_review"))
    handoff.add_argument("--input", required=True)
    return parser


def resolve_root(configured: str | None) -> Path:
    store = store_module()
    value = configured or os.environ.get(store.STORE_ENV)
    return (Path(value).expanduser() if value else Path.home() / ".job-apply").resolve()


def socket_path(root: Path) -> Path:
    root = root.resolve()
    runtime = Path("/tmp") / f"job-apply-attempt-{os.getuid()}"
    try:
        runtime.mkdir(mode=0o700)
    except FileExistsError:
        pass
    details = runtime.lstat()
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISDIR(details.st_mode):
        raise RuntimeError("attempt runtime unavailable")
    if details.st_uid != os.getuid() or stat.S_IMODE(details.st_mode) != 0o700:
        raise RuntimeError("attempt runtime unavailable")
    scope = hashlib.sha256(os.fsencode(root)).hexdigest()
    return runtime / f"{scope}.sock"


def pid_path(root: Path) -> Path:
    return root / PID_NAME


def emit(value: dict[str, Any]) -> None:
    json.dump(value, sys.stdout, sort_keys=True, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def public_acquisition(acquired: dict[str, Any]) -> dict[str, Any]:
    job = acquired["job"]
    resume = acquired["resume"]
    return {
        "job": {key: job[key] for key in ("id", "revision", "url") if key in job},
        "resume": {
            key: resume[key]
            for key in ("id", "revision", "contentRevision", "digest", "path")
            if key in resume
        },
    }


def read_json_object(path: str) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("invalid input")
    return value


def peer_is_current_user(connection: socket.socket) -> bool:
    if hasattr(connection, "getpeereid"):
        uid, _gid = connection.getpeereid()  # type: ignore[attr-defined]
        return uid == os.getuid()
    if hasattr(socket, "SO_PEERCRED"):
        credentials = connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
        )
        _pid, uid, _gid = struct.unpack("3i", credentials)
        return uid == os.getuid()
    # Some macOS Python builds expose neither peer-credential API. The socket
    # still authenticates through its 0600 mode inside the Store's 0700 root:
    # only this OS user (and the OS superuser) can open the endpoint.
    return os.name == "posix" and connection.family == socket.AF_UNIX


def receive_request(connection: socket.socket) -> dict[str, Any]:
    chunks = bytearray()
    while b"\n" not in chunks:
        chunk = connection.recv(65536)
        if not chunk:
            raise ValueError("incomplete request")
        chunks.extend(chunk)
        if len(chunks) > MAX_REQUEST_BYTES:
            raise ValueError("request too large")
    line, remainder = bytes(chunks).split(b"\n", 1)
    if remainder or not line:
        raise ValueError("invalid request framing")
    value = json.loads(line.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("invalid request")
    return value


def send_response(connection: socket.socket, value: dict[str, Any]) -> None:
    connection.sendall(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8") + b"\n"
    )


class AttemptBroker:
    """Own exactly one Store claim and never disclose or persist its bearer."""

    def __init__(self, root: Path, heartbeat_seconds: float = HEARTBEAT_SECONDS) -> None:
        self.root = root
        self.store = store_module().Store(root)
        self.heartbeat_seconds = heartbeat_seconds
        self.job_id: str | None = None
        self.expected_revision: int | None = None
        self._token: str | None = None
        self._stop = threading.Event()
        self._heartbeat_failed = threading.Event()
        self._thread: threading.Thread | None = None

    def acquire(self, request: dict[str, Any]) -> dict[str, Any]:
        if self._token is not None or self.job_id is not None:
            raise ValueError("attempt already acquired")
        if set(request) != {"command", "id", "owner", "expectedRevision"}:
            raise ValueError("invalid request")
        if request["command"] != "start" or not isinstance(request["expectedRevision"], int):
            raise ValueError("invalid request")
        acquired = self.store.acquire_ready_job(
            request["id"], request["owner"], request["expectedRevision"]
        )
        self.job_id = request["id"]
        self._token = acquired.pop("token")
        acquired.pop("claim", None)
        self.expected_revision = acquired["job"]["revision"]
        self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._thread.start()
        return {"ok": True, "event": "acquired", "attempt": public_acquisition(acquired)}

    def _heartbeat(self) -> None:
        if self._token is None or self.job_id is None or self._stop.is_set():
            raise RuntimeError("attempt is not active")
        self.store.heartbeat_claim(self.job_id, self._token)

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(self.heartbeat_seconds):
            try:
                self._heartbeat()
            except Exception:
                self._heartbeat_failed.set()
                self._stop.set()
                return

    def dispatch(self, request: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        if self._token is None or self.job_id is None or self._stop.is_set():
            raise ValueError("attempt is not active")
        if self._heartbeat_failed.is_set():
            raise RuntimeError("attempt heartbeat failed")
        command = request.get("command")
        if command == "heartbeat":
            if set(request) != {"command"}:
                raise ValueError("invalid request")
            self._heartbeat()
            return {"ok": True, "event": "heartbeat"}, False
        if command == "progress":
            if set(request) != {"command", "session"} or not isinstance(request["session"], dict):
                raise ValueError("invalid request")
            self.store.save_claim_progress(self.job_id, self._token, request["session"])
            return {"ok": True, "event": "progress_saved"}, False
        if command == "handoff":
            if set(request) != {"command", "status", "session"}:
                raise ValueError("invalid request")
            status = request["status"]
            if status not in {"needs_info", "awaiting_review"} or not isinstance(request["session"], dict):
                raise ValueError("invalid request")
            self.store.handoff_claimed_job(
                self.job_id, self._token, status, request["session"], self.expected_revision,
            )
            self._token = None
            return {"ok": True, "event": "handed_off", "status": status}, True
        raise ValueError("invalid request")

    def close(self) -> None:
        # Broker loss deliberately leaves Store claim state untouched.
        self._stop.set()
        self._token = None
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=1)


def connect(path: Path, timeout: float = STARTUP_SECONDS) -> socket.socket:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(timeout)
    connection.connect(str(path))
    return connection


def broker_reachable(path: Path) -> bool:
    try:
        connection = connect(path, timeout=0.2)
    except OSError:
        return False
    connection.close()
    return True


def bind_listener(path: Path) -> socket.socket:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(path))
    except OSError as error:
        if error.errno != errno.EADDRINUSE or broker_reachable(path):
            listener.close()
            raise
        path.unlink(missing_ok=True)
        listener.bind(str(path))
    path.chmod(0o600)
    listener.listen(8)
    listener.settimeout(0.5)
    return listener


def run_broker(root: Path) -> int:
    path = socket_path(root)
    process_path = pid_path(root)
    broker = AttemptBroker(root)
    listener = bind_listener(path)
    process_path.write_text(f"{os.getpid()}\n", encoding="ascii")
    process_path.chmod(0o600)
    acquired = False
    deadline = time.monotonic() + IDLE_SECONDS

    def stop(_signum: int, _frame: Any) -> None:
        broker._stop.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not broker._stop.is_set():
            if not acquired and time.monotonic() >= deadline:
                break
            try:
                connection, _address = listener.accept()
            except socket.timeout:
                continue
            with connection:
                try:
                    if not peer_is_current_user(connection):
                        raise PermissionError("peer rejected")
                    request = receive_request(connection)
                    if not acquired:
                        response = broker.acquire(request)
                        acquired = True
                        complete = False
                    else:
                        response, complete = broker.dispatch(request)
                except Exception:
                    response = {"ok": False, "error": {"code": "request_rejected"}}
                    complete = not acquired
                try:
                    send_response(connection, response)
                except OSError:
                    pass
                if complete:
                    break
        return 0
    finally:
        broker.close()
        listener.close()
        path.unlink(missing_ok=True)
        try:
            if process_path.read_text(encoding="ascii").strip() == str(os.getpid()):
                process_path.unlink(missing_ok=True)
        except OSError:
            pass


def detached_broker(root: Path) -> None:
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--broker", "--root", str(root)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )


def request_broker(root: Path, request: dict[str, Any], start: bool = False) -> dict[str, Any]:
    path = socket_path(root)
    deadline = time.monotonic() + STARTUP_SECONDS
    launched = False
    while True:
        try:
            with connect(path, timeout=1.0) as connection:
                send_response(connection, request)
                return receive_request(connection)
        except OSError:
            if not start:
                raise RuntimeError("attempt unavailable")
            if not launched:
                detached_broker(root)
                launched = True
            if time.monotonic() >= deadline:
                raise RuntimeError("attempt unavailable")
            time.sleep(0.05)


def run_client(args: argparse.Namespace) -> int:
    root = resolve_root(args.root)
    if args.command == "start":
        request = {
            "command": "start", "id": args.id, "owner": args.owner,
            "expectedRevision": args.expected_revision,
        }
    elif args.command == "heartbeat":
        request = {"command": "heartbeat"}
    elif args.command == "progress":
        request = {"command": "progress", "session": read_json_object(args.input)}
    else:
        request = {
            "command": "handoff", "status": args.status,
            "session": read_json_object(args.input),
        }
    response = request_broker(root, request, start=args.command == "start")
    emit(response)
    return 0 if response.get("ok") else 2


def main() -> int:
    try:
        if "--broker" in sys.argv[1:]:
            internal = AttemptParser(add_help=False)
            internal.add_argument("--broker", action="store_true")
            internal.add_argument("--root", required=True)
            args = internal.parse_args()
            return run_broker(resolve_root(args.root))
        return run_client(build_parser().parse_args())
    except InvalidInvocation:
        emit({"ok": False, "error": {"code": "invalid_invocation"}})
        return 2
    except Exception:
        emit({"ok": False, "error": {"code": "attempt_unavailable"}})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
