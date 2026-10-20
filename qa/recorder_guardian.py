"""Line protocol and cleanup guardian for the recorder filesystem broker."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import select
import signal
import stat
import sys
from typing import Any

from qa.recorder_broker import SessionBroker
from qa.recorder_fs_ops import MAX_REQUEST_BYTES, BrokerError


_COMMAND_KEYS = {
    "mkdir": {"id", "command", "path"},
    "write-exclusive": {"id", "command", "path", "data"},
    "atomic-replace": {"id", "command", "path", "data"},
    "append": {"id", "command", "path", "data"},
    "remove-tree": {"id", "command", "path"},
    "rename-no-replace": {"id", "command", "source", "destination"},
    "list": {"id", "command", "path"},
    "hash-source-files": {"id", "command"},
    "stat-budget": {"id", "command"},
}


def _decode_data(value: Any) -> bytes:
    if not isinstance(value, str):
        raise BrokerError("invalid-data")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise BrokerError("invalid-data") from None


def _dispatch(broker: SessionBroker, request: Any) -> Any:
    if not isinstance(request, dict):
        raise BrokerError("invalid-request")
    request_id = request.get("id")
    command = request.get("command")
    if not isinstance(request_id, int) or request_id < 0 or command not in _COMMAND_KEYS:
        raise BrokerError("invalid-request")
    if set(request) != _COMMAND_KEYS[command]:
        raise BrokerError("invalid-request")
    if command == "mkdir":
        broker.mkdir(request["path"])
    elif command == "write-exclusive":
        broker.write_exclusive(request["path"], _decode_data(request["data"]))
    elif command == "atomic-replace":
        broker.atomic_replace(request["path"], _decode_data(request["data"]))
    elif command == "append":
        broker.append(request["path"], _decode_data(request["data"]))
    elif command == "remove-tree":
        broker.remove_tree(request["path"])
    elif command == "rename-no-replace":
        broker.rename_no_replace(request["source"], request["destination"])
    elif command == "list":
        return broker.list_path(request["path"])
    elif command == "hash-source-files":
        return broker.hash_source_files()
    elif command == "stat-budget":
        return broker.budget()
    return None


def _bounded_lines(stream: Any, limit: int = MAX_REQUEST_BYTES):
    while True:
        raw = stream.readline(limit + 1)
        if not raw:
            return
        oversized = len(raw) > limit
        if not raw.endswith(b"\n") and not oversized:
            extra = stream.readline(limit + 1)
            if extra:
                oversized = True
                raw = extra
        if oversized:
            while raw and not raw.endswith(b"\n"):
                raw = stream.readline(limit + 1)
            yield None
        else:
            yield raw


def _cleanup_guardian(root_fd: int, root_identity: tuple[int, int], signal_fd: int) -> None:
    try:
        while os.read(signal_fd, 1):
            pass
    except OSError:
        pass
    try:
        current = os.fstat(root_fd)
        if (
            (current.st_dev, current.st_ino) == root_identity
            and stat.S_ISDIR(current.st_mode)
            and current.st_uid == os.getuid()
            and current.st_mode & 0o777 == 0o700
        ):
            try:
                control = os.stat("control.json", dir_fd=root_fd, follow_symlinks=False)
                if stat.S_ISREG(control.st_mode) or stat.S_ISLNK(control.st_mode):
                    os.unlink("control.json", dir_fd=root_fd)
            except FileNotFoundError:
                pass
    except OSError:
        pass
    finally:
        os.close(signal_fd)
        os.close(root_fd)
    os._exit(0)


def _start_cleanup_guardian(broker: SessionBroker) -> tuple[int, int]:
    if not hasattr(os, "fork"):
        raise BrokerError("cleanup-unsupported")
    read_fd, write_fd = os.pipe()
    ready_read, ready_write = os.pipe()
    try:
        pid = os.fork()
    except OSError:
        os.close(read_fd)
        os.close(write_fd)
        os.close(ready_read)
        os.close(ready_write)
        raise BrokerError("cleanup-unavailable") from None
    if pid == 0:
        os.close(write_fd)
        os.close(ready_read)
        try:
            for guardian_signal in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(guardian_signal, signal.SIG_IGN)
            os.setsid()
            os.write(ready_write, b"1")
        except (OSError, ValueError):
            os._exit(1)
        finally:
            os.close(ready_write)
        os.close(broker._parent_fd)
        for descriptor in (0, 1, 2):
            try:
                os.close(descriptor)
            except OSError:
                pass
        _cleanup_guardian(broker._root_fd, broker._root_identity, read_fd)
    os.close(read_fd)
    os.close(ready_write)
    ready = select.select([ready_read], [], [], 2)[0]
    acknowledged = os.read(ready_read, 1) if ready else b""
    os.close(ready_read)
    if acknowledged != b"1":
        os.close(write_fd)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        raise BrokerError("cleanup-unavailable")
    return pid, write_fd


def _serve(root: str) -> int:
    try:
        broker = SessionBroker(root)
    except Exception:
        sys.stderr.write("broker startup failed\n")
        return 1
    try:
        guardian_pid, guardian_signal = _start_cleanup_guardian(broker)
    except BrokerError:
        broker.close()
        sys.stderr.write("broker startup failed\n")
        return 1
    shutdown_requested = False

    def request_shutdown(_signum: int, _frame: object) -> None:
        nonlocal shutdown_requested
        if shutdown_requested:
            return
        shutdown_requested = True
        raise KeyboardInterrupt

    previous_handlers = {
        broker_signal: signal.signal(broker_signal, request_shutdown)
        for broker_signal in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    }
    try:
        sys.stdout.write('{"ready":true}\n')
        sys.stdout.flush()
        for raw in _bounded_lines(sys.stdin.buffer):
            if raw is None:
                response = {"id": None, "ok": False, "code": "request-budget"}
            else:
                request_id = None
                try:
                    request = json.loads(raw)
                    if isinstance(request, dict) and isinstance(request.get("id"), int):
                        request_id = request["id"]
                    result = _dispatch(broker, request)
                    response = {"id": request_id, "ok": True, "result": result}
                except BrokerError as error:
                    response = {"id": request_id, "ok": False, "code": str(error)}
                except Exception:
                    response = {"id": request_id, "ok": False, "code": "invalid-request"}
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        shutdown_requested = True
        try:
            broker.remove_tree("control.json")
        except BrokerError:
            pass
        broker.close()
        os.close(guardian_signal)
        try:
            os.waitpid(guardian_pid, 0)
        except ChildProcessError:
            pass
        for broker_signal, previous_handler in previous_handlers.items():
            signal.signal(broker_signal, previous_handler)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--root", required=True)
    try:
        arguments = parser.parse_args()
    except SystemExit:
        return 2
    return _serve(arguments.root)


if __name__ == "__main__":
    raise SystemExit(main())
