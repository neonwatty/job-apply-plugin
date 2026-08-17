#!/usr/bin/env python3
"""Identity-safe launcher for a dedicated replay-QA Chrome profile."""

import argparse
import errno
import fcntl
import hashlib
import hmac
import http.client
import http.server
import json
import os
import re
import secrets
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path


PROFILE_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DIR_MODE = 0o700
FILE_MODE = 0o600
STARTUP_TIMEOUT = 8.0
REQUEST_TIMEOUT = 1.0
SHUTDOWN_TIMEOUT = 4.0
MAX_BODY = 4096
MAX_CONTROL_CONNECTIONS = 8
ORIGIN = "qa-chrome://local"
ROOT_NAME = ".job-apply-qa"


class UserError(Exception):
    pass


class Ambiguous(UserError):
    pass


def fail(message):
    raise UserError(message)


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n")


def validate_profile(value):
    if not isinstance(value, str) or not PROFILE_RE.fullmatch(value):
        fail("invalid profile identifier")
    return value


def _identity(st):
    return st.st_dev, st.st_ino


def _entry_stat(parent_fd, name):
    return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def _entry_absent(parent_fd, name):
    try:
        _entry_stat(parent_fd, name)
        return False
    except FileNotFoundError:
        return True


def _validate_dir_stat(st, device):
    return (
        stat.S_ISDIR(st.st_mode)
        and st.st_uid == os.getuid()
        and stat.S_IMODE(st.st_mode) == DIR_MODE
        and st.st_dev == device
    )


def _open_child_dir(parent_fd, name, device, create=False):
    if create:
        try:
            os.mkdir(name, DIR_MODE, dir_fd=parent_fd)
        except FileExistsError:
            pass
        except OSError:
            fail("managed storage is unsafe")
    fd = None
    try:
        before = _entry_stat(parent_fd, name)
        fd = os.open(
            name,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
        opened = os.fstat(fd)
        current = _entry_stat(parent_fd, name)
        if (
            not _validate_dir_stat(before, device)
            or not _validate_dir_stat(opened, device)
            or _identity(before) != _identity(opened)
            or _identity(current) != _identity(opened)
        ):
            raise OSError(errno.EPERM, "unsafe")
        return fd, opened
    except OSError:
        if fd is not None:
            os.close(fd)
        fail("managed storage is unsafe")


def _open_home():
    path = os.path.abspath(os.path.expanduser("~"))
    fd = None
    try:
        before = os.lstat(path)
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(fd)
        current = os.lstat(path)
        if (
            not stat.S_ISDIR(before.st_mode)
            or before.st_uid != os.getuid()
            or _identity(before) != _identity(opened)
            or _identity(current) != _identity(opened)
        ):
            raise OSError(errno.EPERM, "unsafe")
        return fd, opened, path
    except OSError:
        if fd is not None:
            os.close(fd)
        fail("managed storage is unsafe")


class BoundPaths:
    """Open, retained descriptors for every managed ancestor used by one command."""

    def __init__(self, profile, create_base=False, create_profile=False):
        self.name = profile
        self.home_fd, self.home_st, self.home_path = _open_home()
        self.root_fd = self.profiles_fd = self.runtime_root_fd = self.profile_fd = self.runtime_fd = None
        try:
            self.root_fd, self.root_st = _open_child_dir(
                self.home_fd, ROOT_NAME, self.home_st.st_dev, create=create_base
            )
            self.profiles_fd, self.profiles_st = _open_child_dir(
                self.root_fd, "chrome-profiles", self.root_st.st_dev, create=create_base
            )
            self.runtime_root_fd, self.runtime_root_st = _open_child_dir(
                self.root_fd, "runtime", self.root_st.st_dev, create=create_base
            )
            if create_profile or not _entry_absent(self.profiles_fd, profile):
                self.profile_fd, self.profile_st = _open_child_dir(
                    self.profiles_fd, profile, self.root_st.st_dev, create=create_profile
                )
            if not _entry_absent(self.runtime_root_fd, profile):
                self.runtime_fd, self.runtime_st = _open_child_dir(
                    self.runtime_root_fd, profile, self.root_st.st_dev
                )
        except BaseException:
            self.close()
            raise

    @classmethod
    def existing(cls, profile):
        home_fd, home_st, _ = _open_home()
        try:
            absent = _entry_absent(home_fd, ROOT_NAME)
        finally:
            os.close(home_fd)
        if absent:
            return None
        return cls(profile)

    @property
    def profile_path(self):
        return os.path.join(self.home_path, ROOT_NAME, "chrome-profiles", self.name)

    def revalidate(self):
        pairs = [
            (self.home_fd, ROOT_NAME, self.root_fd),
            (self.root_fd, "chrome-profiles", self.profiles_fd),
            (self.root_fd, "runtime", self.runtime_root_fd),
        ]
        if self.profile_fd is not None:
            pairs.append((self.profiles_fd, self.name, self.profile_fd))
        if self.runtime_fd is not None:
            pairs.append((self.runtime_root_fd, self.name, self.runtime_fd))
        try:
            for parent_fd, name, child_fd in pairs:
                if _identity(_entry_stat(parent_fd, name)) != _identity(os.fstat(child_fd)):
                    raise OSError(errno.EPERM, "changed")
        except OSError:
            raise Ambiguous("profile state is ambiguous")

    def create_runtime(self):
        if self.runtime_fd is not None or not _entry_absent(self.runtime_root_fd, self.name):
            raise Ambiguous("profile state is ambiguous")
        try:
            os.mkdir(self.name, DIR_MODE, dir_fd=self.runtime_root_fd)
        except OSError:
            raise Ambiguous("profile state is ambiguous")
        self.runtime_fd, self.runtime_st = _open_child_dir(
            self.runtime_root_fd, self.name, self.root_st.st_dev
        )

    def close(self):
        for attr in ("runtime_fd", "profile_fd", "runtime_root_fd", "profiles_fd", "root_fd", "home_fd"):
            fd = getattr(self, attr, None)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(self, attr, None)


def _owner_name(profile):
    return ".job-apply-qa-owner-" + profile


def _ownership_name(profile):
    return ".ownership-" + profile + ".lock"


def _open_owner(paths):
    ownership_fd = None
    owner_fd = None
    name = _owner_name(paths.name)
    ownership_name = _ownership_name(paths.name)
    try:
        flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        try:
            ownership_fd = os.open(ownership_name, flags, dir_fd=paths.root_fd)
        except FileNotFoundError:
            try:
                ownership_fd = os.open(
                    ownership_name, flags | os.O_CREAT | os.O_EXCL, FILE_MODE, dir_fd=paths.root_fd
                )
            except FileExistsError:
                ownership_fd = os.open(ownership_name, flags, dir_fd=paths.root_fd)
        ownership = os.fstat(ownership_fd)
        ownership_current = _entry_stat(paths.root_fd, ownership_name)
        if (
            not stat.S_ISREG(ownership.st_mode)
            or ownership.st_uid != os.getuid()
            or stat.S_IMODE(ownership.st_mode) != FILE_MODE
            or ownership.st_dev != paths.root_st.st_dev
            or ownership.st_nlink != 1
            or _identity(ownership) != _identity(ownership_current)
        ):
            raise OSError(errno.EPERM, "unsafe")
        # This lock lives in the stable managed root rather than any owner,
        # profile, or runtime entry that an attacker can replace together.
        fcntl.flock(ownership_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        try:
            owner_fd = os.open(name, flags, dir_fd=paths.home_fd)
        except FileNotFoundError:
            try:
                owner_fd = os.open(name, flags | os.O_CREAT | os.O_EXCL, FILE_MODE, dir_fd=paths.home_fd)
            except FileExistsError:
                owner_fd = os.open(name, flags, dir_fd=paths.home_fd)
        before = os.fstat(owner_fd)
        current = _entry_stat(paths.home_fd, name)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.getuid()
            or stat.S_IMODE(before.st_mode) != FILE_MODE
            or before.st_dev != paths.home_st.st_dev
            or before.st_nlink != 1
            or _identity(before) != _identity(current)
        ):
            raise OSError(errno.EPERM, "unsafe")
        # The home directory is the trusted descriptor above the replaceable
        # managed root. Retain this lock for the supervisor's full lifetime so
        # replacing the root cannot create a second per-profile owner.
        fcntl.flock(owner_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return ownership_fd, owner_fd
    except BlockingIOError:
        if owner_fd is not None:
            os.close(owner_fd)
        if ownership_fd is not None:
            os.close(ownership_fd)
        return None
    except OSError:
        if owner_fd is not None:
            os.close(owner_fd)
        if ownership_fd is not None:
            os.close(ownership_fd)
        raise Ambiguous("profile state is ambiguous")


def _observe_owner(paths):
    """Observe complete per-profile ownership without creating or changing it."""
    ownership_fd = None
    owner_fd = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        ownership_name = _ownership_name(paths.name)
        ownership_fd = os.open(ownership_name, flags, dir_fd=paths.root_fd)
        ownership = os.fstat(ownership_fd)
        ownership_current = _entry_stat(paths.root_fd, ownership_name)
        if (
            not stat.S_ISREG(ownership.st_mode)
            or ownership.st_uid != os.getuid()
            or stat.S_IMODE(ownership.st_mode) != FILE_MODE
            or ownership.st_dev != paths.root_st.st_dev
            or ownership.st_nlink != 1
            or _identity(ownership) != _identity(ownership_current)
        ):
            raise OSError(errno.EPERM, "unsafe")
        fcntl.flock(ownership_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

        owner_name = _owner_name(paths.name)
        owner_fd = os.open(owner_name, flags, dir_fd=paths.home_fd)
        owner = os.fstat(owner_fd)
        owner_current = _entry_stat(paths.home_fd, owner_name)
        if (
            not stat.S_ISREG(owner.st_mode)
            or owner.st_uid != os.getuid()
            or stat.S_IMODE(owner.st_mode) != FILE_MODE
            or owner.st_dev != paths.home_st.st_dev
            or owner.st_nlink != 1
            or _identity(owner) != _identity(owner_current)
        ):
            raise OSError(errno.EPERM, "unsafe")
        fcntl.flock(owner_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return ownership_fd, owner_fd
    except BlockingIOError:
        if owner_fd is not None:
            os.close(owner_fd)
        if ownership_fd is not None:
            os.close(ownership_fd)
        return None
    except OSError:
        if owner_fd is not None:
            os.close(owner_fd)
        if ownership_fd is not None:
            os.close(ownership_fd)
        raise Ambiguous("profile state is ambiguous")


def _write_owner_runtime(owner_fd, runtime_st):
    payload = json.dumps({"device": runtime_st.st_dev, "inode": runtime_st.st_ino}, separators=(",", ":")).encode("ascii")
    os.pwrite(owner_fd, payload, 0)
    os.ftruncate(owner_fd, len(payload))
    os.fsync(owner_fd)


def _owner_matches_runtime(paths):
    fd = None
    try:
        name = _owner_name(paths.name)
        before = _entry_stat(paths.home_fd, name)
        fd = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=paths.home_fd)
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != os.getuid()
            or stat.S_IMODE(opened.st_mode) != FILE_MODE
            or opened.st_dev != paths.home_st.st_dev
            or opened.st_nlink != 1
            or _identity(before) != _identity(opened)
            or opened.st_size > 128
            or paths.runtime_fd is None
        ):
            return False
        if opened.st_size == 0:
            return None
        value = json.loads(os.read(fd, 129).decode("ascii"))
        return value == {"device": paths.runtime_st.st_dev, "inode": paths.runtime_st.st_ino}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    except OSError:
        return False
    finally:
        if fd is not None:
            os.close(fd)


def _safe_regular(dir_fd, name, device, max_bytes=MAX_BODY):
    fd = None
    try:
        before = _entry_stat(dir_fd, name)
        fd = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=dir_fd)
        opened = os.fstat(fd)
        current = _entry_stat(dir_fd, name)
        for value in (before, opened, current):
            if (
                not stat.S_ISREG(value.st_mode)
                or value.st_uid != os.getuid()
                or stat.S_IMODE(value.st_mode) != FILE_MODE
                or value.st_dev != device
                or value.st_size > max_bytes
                or value.st_nlink != 1
            ):
                raise OSError(errno.EPERM, "unsafe")
        if _identity(before) != _identity(opened) or _identity(current) != _identity(opened):
            raise OSError(errno.EPERM, "changed")
        data = os.read(fd, max_bytes + 1)
        final = os.fstat(fd)
        if (
            _identity(final) != _identity(opened)
            or final.st_size != opened.st_size
            or stat.S_IMODE(final.st_mode) != FILE_MODE
            or final.st_uid != os.getuid()
            or final.st_dev != device
        ):
            raise OSError(errno.EPERM, "changed")
        return data
    except OSError:
        raise Ambiguous("profile state is ambiguous")
    finally:
        if fd is not None:
            os.close(fd)


def _read_json(paths, name, keys):
    if paths.runtime_fd is None:
        raise Ambiguous("profile state is ambiguous")
    paths.revalidate()
    try:
        value = json.loads(_safe_regular(paths.runtime_fd, name, paths.runtime_st.st_dev).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise Ambiguous("profile state is ambiguous")
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Ambiguous("profile state is ambiguous")
    return value


def _atomic_json(paths, name, value):
    paths.revalidate()
    payload = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    temp = "." + name + "." + secrets.token_hex(8)
    fd = None
    try:
        fd = os.open(
            temp,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            FILE_MODE,
            dir_fd=paths.runtime_fd,
        )
        os.write(fd, payload)
        os.fsync(fd)
        created = os.fstat(fd)
        os.close(fd)
        fd = None
        os.link(temp, name, src_dir_fd=paths.runtime_fd, dst_dir_fd=paths.runtime_fd, follow_symlinks=False)
        os.unlink(temp, dir_fd=paths.runtime_fd)
        os.fsync(paths.runtime_fd)
        published = _entry_stat(paths.runtime_fd, name)
        if _identity(created) != _identity(published) or published.st_nlink != 1:
            raise OSError(errno.EPERM, "publication")
        paths.revalidate()
        return _identity(published)
    except OSError:
        raise Ambiguous("profile state is ambiguous")
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temp, dir_fd=paths.runtime_fd)
        except OSError:
            pass


def discover_chrome(explicit):
    if explicit is not None:
        candidate = Path(explicit)
        if not candidate.is_absolute():
            fail("invalid Chrome executable")
        try:
            st = os.lstat(str(candidate))
        except OSError:
            fail("invalid Chrome executable")
        if (
            not stat.S_ISREG(st.st_mode)
            or st.st_uid != os.getuid()
            or not st.st_mode & 0o111
        ):
            fail("invalid Chrome executable")
        return str(candidate), st.st_dev, st.st_ino
    if sys.platform != "darwin":
        fail("unsupported platform")
    for candidate in (
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path(os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")),
    ):
        try:
            st = os.lstat(str(candidate))
        except OSError:
            continue
        if stat.S_ISREG(st.st_mode) and st.st_mode & 0o111:
            return str(candidate), st.st_dev, st.st_ino
    fail("Chrome executable not found")


def _browser_path_hash(browser_path):
    return hashlib.sha256(browser_path.encode("ascii")).hexdigest()


def _cdp_browser_path(port):
    if not isinstance(port, int) or not 0 < port < 65536:
        return None
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=REQUEST_TIMEOUT)
    try:
        connection.request("GET", "/json/version", headers={"Host": "127.0.0.1:%d" % port})
        response = connection.getresponse()
        body = response.read(MAX_BODY + 1)
        if response.status != 200 or len(body) > MAX_BODY:
            return None
        value = json.loads(body.decode("utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("Protocol-Version"), str):
            return None
        websocket = value.get("webSocketDebuggerUrl")
        if not isinstance(websocket, str):
            return None
        parsed = urllib.parse.urlsplit(websocket)
        try:
            if (
                parsed.scheme != "ws"
                or parsed.hostname != "127.0.0.1"
                or parsed.port != port
                or parsed.username is not None
                or parsed.password is not None
                or parsed.query
                or parsed.fragment
            ):
                return None
        except ValueError:
            return None
        if not re.fullmatch(r"/devtools/browser/[A-Za-z0-9._-]+", parsed.path):
            return None
        return parsed.path
    except (OSError, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError):
        return None
    finally:
        connection.close()


def _probe_cdp(port, browser_path=None, browser_path_hash=None):
    observed = _cdp_browser_path(port)
    if observed is None:
        return False
    if browser_path is not None and observed != browser_path:
        return False
    if browser_path_hash is not None and not hmac.compare_digest(
        _browser_path_hash(observed), browser_path_hash
    ):
        return False
    return True


def _public_ready(profile, port):
    url = "http://127.0.0.1:%d" % port
    return {
        "profile": profile,
        "status": "ready",
        "cdpUrl": url,
        "recorderCommand": "node qa/recorder.mjs record --cdp-url %s --output .qa-private/REPLACE_WITH_UNIQUE_SESSION_ID" % url,
    }


def _control_request(paths, action):
    control = _read_json(paths, "control.json", {"version", "port", "token", "generation"})
    state = _read_json(paths, "state.json", {
        "version", "profile", "status", "cdpPort", "cdpBrowserPathHash", "generation",
    })
    if (
        control["version"] != 1
        or state["version"] != 1
        or state["profile"] != paths.name
        or state["status"] != "ready"
        or not isinstance(control["port"], int)
        or not isinstance(control["token"], str)
        or len(control["token"]) != 64
        or not isinstance(state["cdpBrowserPathHash"], str)
        or len(state["cdpBrowserPathHash"]) != 64
        or control["generation"] != state["generation"]
    ):
        raise Ambiguous("profile state is ambiguous")
    body = json.dumps({"action": action, "token": control["token"]}, separators=(",", ":"))
    connection = http.client.HTTPConnection("127.0.0.1", control["port"], timeout=REQUEST_TIMEOUT)
    try:
        connection.request("POST", "/control", body=body, headers={
            "Host": "127.0.0.1:%d" % control["port"],
            "Origin": ORIGIN,
            "Content-Type": "application/json",
        })
        response = connection.getresponse()
        raw = response.read(MAX_BODY + 1)
        if response.status != 200 or len(raw) > MAX_BODY:
            raise Ambiguous("profile state is ambiguous")
        value = json.loads(raw.decode("utf-8"))
    except (OSError, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError):
        raise Ambiguous("profile state is ambiguous")
    finally:
        connection.close()
    if action == "check" and value == {"status": "ready"} and _probe_cdp(
        state["cdpPort"], browser_path_hash=state["cdpBrowserPathHash"]
    ):
        return state
    if action == "stop" and value == {"status": "stopping"}:
        return state
    raise Ambiguous("profile state is ambiguous")


class ControlServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = False
    daemon_threads = True
    block_on_close = False

    def __init__(self, address, handler, token, child, cdp_port, browser_path, paths, ownership_fd, published):
        self.token = token
        self.child = child
        self.cdp_port = cdp_port
        self.browser_path = browser_path
        self.paths = paths
        self.ownership_fd = ownership_fd
        self.ownership_identity = _identity(os.fstat(ownership_fd))
        self.published = published
        self.connection_slots = threading.BoundedSemaphore(MAX_CONTROL_CONNECTIONS)
        self.stopping = False
        super().__init__(address, handler)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(REQUEST_TIMEOUT)
        return request, address

    def process_request(self, request, client_address):
        if not self.connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connection_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()

    def authorized(self):
        try:
            self.paths.revalidate()
            ownership = _entry_stat(self.paths.root_fd, _ownership_name(self.paths.name))
            if (
                _identity(ownership) != self.ownership_identity
                or _identity(os.fstat(self.ownership_fd)) != self.ownership_identity
                or self.published.get("state") is None
                or self.published.get("control") is None
            ):
                return False
            for name in ("state", "control"):
                filename = name + ".json"
                current = _entry_stat(self.paths.runtime_fd, filename)
                if _identity(current) != self.published[name]:
                    return False
                _safe_regular(self.paths.runtime_fd, filename, self.paths.runtime_st.st_dev)
            return _owner_matches_runtime(self.paths) is True
        except (OSError, UserError):
            return False


class ControlHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError):
            pass

    def do_POST(self):
        server = self.server
        expected_host = "127.0.0.1:%d" % server.server_address[1]
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if (
            self.client_address[0] != "127.0.0.1"
            or self.path != "/control"
            or self.headers.get("Host") != expected_host
            or self.headers.get("Origin") != ORIGIN
            or self.headers.get("Content-Type") != "application/json"
            or not 0 <= length <= MAX_BODY
        ):
            self._send(400, {"status": "error"})
            return
        try:
            raw = self.rfile.read(length)
        except (socket.timeout, OSError):
            return
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, {"status": "error"})
            return
        if (
            not isinstance(request, dict)
            or set(request) != {"action", "token"}
            or request["action"] not in ("check", "stop")
            or not isinstance(request["token"], str)
            or not hmac.compare_digest(request["token"], server.token)
        ):
            self._send(400, {"status": "error"})
            return
        if not server.authorized():
            self._send(400, {"status": "error"})
            return
        if request["action"] == "check":
            if server.child.poll() is not None or not _probe_cdp(
                server.cdp_port, browser_path=server.browser_path
            ):
                self._send(400, {"status": "error"})
                return
            payload = {"status": "ready"}
        else:
            server.stopping = True
            payload = {"status": "stopping"}
        self._send(200, payload)

    def log_message(self, *_args):
        pass


def _read_new_devtools(paths, launched_at, child, expected_port):
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        if child.poll() is not None:
            break
        browser_path = _cdp_browser_path(expected_port)
        if browser_path is not None:
            return expected_port, browser_path
        try:
            before = _entry_stat(paths.profile_fd, "DevToolsActivePort")
            if (
                stat.S_ISREG(before.st_mode)
                and before.st_uid == os.getuid()
                and before.st_dev == paths.profile_st.st_dev
                and before.st_nlink == 1
                and not stat.S_IMODE(before.st_mode) & 0o022
                and before.st_mtime_ns >= launched_at
                and before.st_size <= 256
            ):
                fd = os.open("DevToolsActivePort", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=paths.profile_fd)
                try:
                    opened = os.fstat(fd)
                    data = os.read(fd, 257)
                    final = os.fstat(fd)
                    current = _entry_stat(paths.profile_fd, "DevToolsActivePort")
                finally:
                    os.close(fd)
                if (
                    _identity(before) == _identity(opened) == _identity(current)
                    and all(stat.S_ISREG(value.st_mode) for value in (opened, current, final))
                    and all(value.st_uid == os.getuid() for value in (opened, current, final))
                    and all(value.st_dev == paths.profile_st.st_dev for value in (opened, current, final))
                    and all(value.st_nlink == 1 for value in (opened, current, final))
                    and all(not stat.S_IMODE(value.st_mode) & 0o022 for value in (opened, current, final))
                ):
                    lines = data.decode("ascii").splitlines()
                    if (
                        len(lines) == 2
                        and lines[0].isdigit()
                        and re.fullmatch(r"/devtools/browser/[A-Za-z0-9._-]+", lines[1])
                    ):
                        port = int(lines[0])
                        if port == expected_port and _probe_cdp(port, browser_path=lines[1]):
                            return port, lines[1]
        except (OSError, UnicodeDecodeError, ValueError):
            pass
        time.sleep(0.04)
    return None


def _unlink_identity(dir_fd, name, identity, device):
    if identity is None:
        return True
    try:
        current = _entry_stat(dir_fd, name)
    except FileNotFoundError:
        return True
    if (
        stat.S_ISREG(current.st_mode)
        and current.st_uid == os.getuid()
        and stat.S_IMODE(current.st_mode) == FILE_MODE
        and current.st_dev == device
        and current.st_nlink == 1
        and _identity(current) == identity
    ):
        os.unlink(name, dir_fd=dir_fd)
        return True
    return False


def _cleanup_runtime(paths, published):
    try:
        paths.revalidate()
        if not _unlink_identity(paths.runtime_fd, "state.json", published.get("state"), paths.runtime_st.st_dev):
            return
        if not _unlink_identity(paths.runtime_fd, "control.json", published.get("control"), paths.runtime_st.st_dev):
            return
        paths.revalidate()
        os.rmdir(paths.name, dir_fd=paths.runtime_root_fd)
        os.fsync(paths.runtime_root_fd)
    except OSError:
        pass


def _terminate_exact_child(child):
    deadline = time.monotonic() + SHUTDOWN_TIMEOUT
    if child.poll() is not None:
        child.wait()
        return
    child.terminate()
    try:
        child.wait(timeout=max(0.05, deadline - time.monotonic()))
        return
    except subprocess.TimeoutExpired:
        child.kill()
    child.wait(timeout=max(0.05, deadline - time.monotonic()))


def _supervisor(paths, chrome, ownership_fd, owner_fd, ready_fd):
    child = None
    server = None
    published = {}
    stopping = {"value": False}
    try:
        os.setsid()
    except OSError:
        pass
    nullfd = os.open(os.devnull, os.O_RDWR)
    for number in (0, 1, 2):
        os.dup2(nullfd, number)
    os.close(nullfd)

    def on_signal(_signum, _frame):
        stopping["value"] = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        paths.revalidate()
        launched_at = time.time_ns()
        chrome_path, chrome_device, chrome_inode = chrome
        executable = os.lstat(chrome_path)
        if (
            not stat.S_ISREG(executable.st_mode)
            or _identity(executable) != (chrome_device, chrome_inode)
            or not executable.st_mode & 0o111
        ):
            raise RuntimeError("executable identity")
        reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        reservation.bind(("127.0.0.1", 0))
        cdp_port = reservation.getsockname()[1]
        reservation.close()
        child = subprocess.Popen([
            chrome_path,
            "--user-data-dir=" + paths.profile_path,
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=%d" % cdp_port,
            "--no-first-run",
            "--no-default-browser-check",
            "--new-window",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        paths.revalidate()
        executable_after = os.lstat(chrome_path)
        if _identity(executable_after) != (chrome_device, chrome_inode):
            raise RuntimeError("executable identity")
        devtools = _read_new_devtools(paths, launched_at, child, cdp_port)
        if devtools is None or stopping["value"]:
            raise RuntimeError("startup")
        port, browser_path = devtools
        token = secrets.token_hex(32)
        generation = secrets.token_hex(16)
        server = ControlServer(
            ("127.0.0.1", 0), ControlHandler, token, child, port, browser_path,
            paths, ownership_fd, published,
        )
        server.timeout = 0.2
        published["control"] = _atomic_json(paths, "control.json", {
            "version": 1, "port": server.server_address[1], "token": token, "generation": generation,
        })
        published["state"] = _atomic_json(paths, "state.json", {
            "version": 1,
            "profile": paths.name,
            "status": "ready",
            "cdpPort": port,
            "cdpBrowserPathHash": _browser_path_hash(browser_path),
            "generation": generation,
        })
        readiness = socket.socket(fileno=ready_fd)
        readiness.settimeout(REQUEST_TIMEOUT)
        readiness.sendall(json.dumps({"ok": True, "port": port}).encode("ascii"))
        readiness.shutdown(socket.SHUT_WR)
        if readiness.recv(16) != b"ack\n":
            raise RuntimeError("parent acknowledgement")
        readiness.close()
        ready_fd = -1
        while child.poll() is None and not server.stopping and not stopping["value"]:
            server.handle_request()
    except BaseException:
        if ready_fd >= 0:
            try:
                os.write(ready_fd, b'{"ok":false}')
            except OSError:
                pass
    finally:
        if ready_fd >= 0:
            os.close(ready_fd)
        if server is not None:
            server.server_close()
        if child is not None:
            try:
                _terminate_exact_child(child)
            except BaseException:
                pass
        _cleanup_runtime(paths, published)
        paths.close()
        try:
            os.close(ownership_fd)
        except OSError:
            pass
        try:
            os.close(owner_fd)
        except OSError:
            pass
        os._exit(0)


def _remove_stale_devtools(paths):
    try:
        current = _entry_stat(paths.profile_fd, "DevToolsActivePort")
    except FileNotFoundError:
        return
    if (
        not stat.S_ISREG(current.st_mode)
        or current.st_uid != os.getuid()
        or current.st_dev != paths.profile_st.st_dev
        or current.st_nlink != 1
    ):
        raise Ambiguous("profile state is ambiguous")
    paths.revalidate()
    if _identity(_entry_stat(paths.profile_fd, "DevToolsActivePort")) != _identity(current):
        raise Ambiguous("profile state is ambiguous")
    os.unlink("DevToolsActivePort", dir_fd=paths.profile_fd)


def command_start(profile, chrome_path):
    chrome = discover_chrome(chrome_path)
    setup_deadline = time.monotonic() + 0.5
    while True:
        try:
            paths = BoundPaths(profile, create_base=True, create_profile=True)
            break
        except UserError:
            if time.monotonic() >= setup_deadline:
                raise
            time.sleep(0.02)
    owner = _open_owner(paths)
    if owner is None:
        expected_runtime = _identity(paths.runtime_st) if paths.runtime_fd is not None else None
        generation = None
        if paths.runtime_fd is not None:
            try:
                initial = _read_json(paths, "state.json", {
                    "version", "profile", "status", "cdpPort", "cdpBrowserPathHash", "generation",
                })
                if initial.get("version") == 1 and initial.get("profile") == profile and initial.get("status") == "ready":
                    generation = initial.get("generation")
            except Ambiguous:
                pass
        paths.close()
        try:
            deadline = time.monotonic() + STARTUP_TIMEOUT + 3
            while time.monotonic() < deadline:
                current = None
                try:
                    current = BoundPaths.existing(profile)
                    if current is None or current.runtime_fd is None:
                        raise Ambiguous("profile state is ambiguous")
                    if expected_runtime is not None and _identity(current.runtime_st) != expected_runtime:
                        raise Ambiguous("profile state is ambiguous")
                    if _owner_matches_runtime(current) is False:
                        raise Ambiguous("profile state is ambiguous")
                    if generation is not None:
                        observed = _read_json(current, "state.json", {
                            "version", "profile", "status", "cdpPort", "cdpBrowserPathHash", "generation",
                        })
                        if observed.get("generation") != generation:
                            raise Ambiguous("profile state is ambiguous")
                    state = _control_request(current, "check")
                    emit(_public_ready(profile, state["cdpPort"]))
                    return
                except Ambiguous:
                    if current is not None and expected_runtime is not None and current.runtime_fd is not None and _identity(current.runtime_st) != expected_runtime:
                        raise
                    if current is not None and current.runtime_fd is not None and _owner_matches_runtime(current) is False:
                        raise
                except UserError:
                    pass
                finally:
                    if current is not None:
                        current.close()
                time.sleep(0.04)
            raise Ambiguous("profile state is ambiguous")
        finally:
            pass
    if paths.runtime_fd is not None:
        os.close(owner[1])
        os.close(owner[0])
        paths.close()
        raise Ambiguous("profile state is ambiguous")
    ownership_fd, owner_fd = owner
    try:
        paths.create_runtime()
        _write_owner_runtime(owner_fd, paths.runtime_st)
        _remove_stale_devtools(paths)
        parent_ready, child_ready = socket.socketpair()
        pid = os.fork()
        if pid == 0:
            parent_ready.close()
            _supervisor(paths, chrome, ownership_fd, owner_fd, child_ready.detach())
        child_ready.close()
        os.close(ownership_fd)
        ownership_fd = -1
        os.close(owner_fd)
        owner_fd = -1
        paths.close()
        deadline = time.monotonic() + STARTUP_TIMEOUT + 1
        chunks = []
        parent_ready.setblocking(False)
        while time.monotonic() < deadline:
            try:
                chunk = parent_ready.recv(MAX_BODY)
                if chunk:
                    chunks.append(chunk)
                    continue
                if chunk == b"":
                    break
            except BlockingIOError:
                pass
            time.sleep(0.04)
        try:
            answer = json.loads(b"".join(chunks).decode("ascii"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            answer = {"ok": False}
        if answer.get("ok") is not True or not isinstance(answer.get("port"), int):
            fail("Chrome did not become ready")
        emit(_public_ready(profile, answer["port"]))
        sys.stdout.flush()
        parent_ready.sendall(b"ack\n")
        parent_ready.close()
    except BaseException:
        try:
            parent_ready.close()
        except (NameError, OSError):
            pass
        try:
            if owner_fd >= 0:
                os.close(owner_fd)
            if ownership_fd >= 0:
                os.close(ownership_fd)
        except OSError:
            pass
        paths.close()
        raise


def command_check(profile):
    paths = BoundPaths.existing(profile)
    if paths is None:
        emit({"profile": profile, "status": "stopped"})
        return
    try:
        if paths.profile_fd is None:
            emit({"profile": profile, "status": "stopped"})
            return
        if paths.runtime_fd is None:
            emit({"profile": profile, "status": "stopped"})
            return
        state = _control_request(paths, "check")
        emit(_public_ready(profile, state["cdpPort"]))
    finally:
        paths.close()


def command_stop(profile):
    paths = BoundPaths.existing(profile)
    if paths is None:
        emit({"profile": profile, "status": "stopped"})
        return
    try:
        if paths.profile_fd is None or paths.runtime_fd is None:
            emit({"profile": profile, "status": "stopped"})
            return
        _control_request(paths, "stop")
        deadline = time.monotonic() + SHUTDOWN_TIMEOUT + 1
        while time.monotonic() < deadline:
            try:
                current = _entry_stat(paths.runtime_root_fd, profile)
            except FileNotFoundError:
                owner = _observe_owner(paths)
                if owner is None:
                    time.sleep(0.04)
                    continue
                os.close(owner[1])
                os.close(owner[0])
                emit({"profile": profile, "status": "stopped"})
                return
            if _identity(current) != _identity(paths.runtime_st):
                raise Ambiguous("profile state is ambiguous")
            time.sleep(0.04)
        raise Ambiguous("profile state is ambiguous")
    finally:
        paths.close()


def _manual_profile_path(profile):
    return "~/.job-apply-qa/chrome-profiles/%s" % profile


def _emit_manual_reset(profile):
    emit(
        {
            "profile": profile,
            "status": "manual-removal-required",
            "profilePath": _manual_profile_path(profile),
        }
    )


def command_reset(profile):
    try:
        paths = BoundPaths.existing(profile)
    except Ambiguous:
        fail("profile state is ambiguous; resolve it before reset guidance")
    if paths is None or paths.profile_fd is None:
        if paths is not None:
            paths.close()
        _emit_manual_reset(profile)
        return
    owner = None
    try:
        owner = _observe_owner(paths)
        if owner is None:
            fail("profile is active; stop it before reset guidance")
        if paths.runtime_fd is not None:
            fail("profile state is ambiguous; resolve it before reset guidance")
        paths.revalidate()
        source = _entry_stat(paths.profiles_fd, profile)
        if _identity(source) != _identity(paths.profile_st):
            fail("profile state is ambiguous; resolve it before reset guidance")
        _emit_manual_reset(profile)
    except Ambiguous:
        fail("profile state is ambiguous; resolve it before reset guidance")
    except OSError:
        fail("managed storage is unsafe")
    finally:
        if owner is not None:
            os.close(owner[1])
            os.close(owner[0])
        paths.close()


class QuietParser(argparse.ArgumentParser):
    def error(self, _message):
        fail("invalid arguments")


def parse_args(argv):
    parser = QuietParser(add_help=True)
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start")
    start.add_argument("--profile", required=True)
    start.add_argument("--chrome-path")
    for name in ("check", "stop"):
        child = sub.add_parser(name)
        child.add_argument("--profile", required=True)
    reset = sub.add_parser("reset")
    reset.add_argument("--profile", required=True)
    return parser.parse_args(argv)


def main(argv=None):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        profile = validate_profile(args.profile)
        if args.command == "start":
            command_start(profile, args.chrome_path)
        elif args.command == "check":
            command_check(profile)
        elif args.command == "stop":
            command_stop(profile)
        else:
            command_reset(profile)
        return 0
    except UserError as error:
        sys.stderr.write(str(error) + "\n")
        return 2
    except KeyboardInterrupt:
        sys.stderr.write("operation interrupted\n")
        return 130


if __name__ == "__main__":
    sys.exit(main())
