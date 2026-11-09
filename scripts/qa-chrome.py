#!/usr/bin/env python3
"""Identity-safe launcher for a dedicated replay-QA Chrome profile."""

import argparse
import errno
import fcntl
import hashlib
import hmac
import http.client
from importlib import import_module as _import_module
from importlib.util import module_from_spec as _module_from_spec
from importlib.util import spec_from_file_location as _spec_from_file_location
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


_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_IMPLEMENTATION_ROOT = (_REPO_ROOT / "qa" / "chrome").resolve()
_PACKAGE_NAME = "_job_apply_qa_chrome_parts_" + hashlib.sha256(
    str(_IMPLEMENTATION_ROOT).encode("utf-8")
).hexdigest()
for _module_name in tuple(sys.modules):
    if _module_name == _PACKAGE_NAME or _module_name.startswith(
        _PACKAGE_NAME + "."
    ):
        del sys.modules[_module_name]
_package_spec = _spec_from_file_location(
    _PACKAGE_NAME,
    _IMPLEMENTATION_ROOT / "__init__.py",
    submodule_search_locations=[str(_IMPLEMENTATION_ROOT)],
)
if _package_spec is None or _package_spec.loader is None:
    raise ImportError("QA Chrome implementation package is unavailable")
_package = _module_from_spec(_package_spec)
sys.modules[_PACKAGE_NAME] = _package
try:
    _package_spec.loader.exec_module(_package)
except BaseException:
    for _module_name in tuple(sys.modules):
        if _module_name == _PACKAGE_NAME or _module_name.startswith(
            _PACKAGE_NAME + "."
        ):
            del sys.modules[_module_name]
    raise

_cli = _import_module(f"{_PACKAGE_NAME}.cli")
_commands = _import_module(f"{_PACKAGE_NAME}.commands")
_control = _import_module(f"{_PACKAGE_NAME}.control")
_discovery = _import_module(f"{_PACKAGE_NAME}.discovery")
_owner = _import_module(f"{_PACKAGE_NAME}.owner")
_paths = _import_module(f"{_PACKAGE_NAME}.paths")
_supervisor_module = _import_module(f"{_PACKAGE_NAME}.supervisor")


PROFILE_RE = _paths.PROFILE_RE
DIR_MODE = _paths.DIR_MODE
FILE_MODE = _paths.FILE_MODE
STARTUP_TIMEOUT = _paths.STARTUP_TIMEOUT
REQUEST_TIMEOUT = _paths.REQUEST_TIMEOUT
SHUTDOWN_TIMEOUT = _paths.SHUTDOWN_TIMEOUT
MAX_BODY = _paths.MAX_BODY
MAX_CONTROL_CONNECTIONS = _paths.MAX_CONTROL_CONNECTIONS
ORIGIN = _paths.ORIGIN
ROOT_NAME = _paths.ROOT_NAME

class UserError(Exception):
    pass


class Ambiguous(UserError):
    pass


_FACADE_RUNTIME = _cli.FacadeRuntime(globals())
_runtime = _FACADE_RUNTIME.resolve


class BoundPaths(_paths.BoundPaths):
    """Open, retained descriptors for every managed ancestor used by one command."""

    _runtime_provider = staticmethod(_runtime)


class ControlServer(_control.ControlServer):
    _runtime_provider = staticmethod(_runtime)


class ControlHandler(_control.ControlHandler):
    pass


class QuietParser(_cli.QuietParser):
    _runtime_provider = staticmethod(_runtime)


def fail(message):
    return _paths.fail(message, _runtime=_runtime())


def emit(payload):
    return _paths.emit(payload, _runtime=_runtime())


def validate_profile(value):
    return _paths.validate_profile(value, _runtime=_runtime())


def _identity(st):
    return _paths._identity(st)


def _entry_stat(parent_fd, name):
    return _paths._entry_stat(parent_fd, name, _runtime=_runtime())


def _entry_absent(parent_fd, name):
    return _paths._entry_absent(parent_fd, name, _runtime=_runtime())


def _validate_dir_stat(st, device):
    return _paths._validate_dir_stat(st, device, _runtime=_runtime())


def _open_child_dir(parent_fd, name, device, create=False):
    return _paths._open_child_dir(
        parent_fd, name, device, create, _runtime=_runtime()
    )


def _open_home():
    return _paths._open_home(_runtime=_runtime())


def _owner_name(profile):
    return _owner._owner_name(profile, _runtime=_runtime())


def _ownership_name(profile):
    return _owner._ownership_name(profile, _runtime=_runtime())


def _open_owner(paths):
    return _owner._open_owner(paths, _runtime=_runtime())


def _observe_owner(paths):
    """Observe complete per-profile ownership without creating or changing it."""
    return _owner._observe_owner(paths, _runtime=_runtime())


def _write_owner_runtime(owner_fd, runtime_st):
    return _owner._write_owner_runtime(
        owner_fd, runtime_st, _runtime=_runtime()
    )


def _owner_matches_runtime(paths):
    return _owner._owner_matches_runtime(paths, _runtime=_runtime())


def _safe_regular(dir_fd, name, device, max_bytes=MAX_BODY):
    return _paths._safe_regular(
        dir_fd, name, device, max_bytes, _runtime=_runtime()
    )


def _read_json(paths, name, keys):
    return _paths._read_json(paths, name, keys, _runtime=_runtime())


def _atomic_json(paths, name, value):
    return _paths._atomic_json(paths, name, value, _runtime=_runtime())


def discover_chrome(explicit):
    return _discovery.discover_chrome(explicit, _runtime=_runtime())


def _browser_path_hash(browser_path):
    return _discovery._browser_path_hash(
        browser_path, _runtime=_runtime()
    )


def _cdp_browser_path(port):
    return _discovery._cdp_browser_path(port, _runtime=_runtime())


def _probe_cdp(port, browser_path=None, browser_path_hash=None):
    return _discovery._probe_cdp(
        port,
        browser_path,
        browser_path_hash,
        _runtime=_runtime(),
    )


def _public_ready(profile, port):
    return _control._public_ready(profile, port, _runtime=_runtime())


def _control_request(paths, action):
    return _control._control_request(paths, action, _runtime=_runtime())


def _read_new_devtools(paths, launched_at, child, expected_port):
    return _supervisor_module._read_new_devtools(
        paths,
        launched_at,
        child,
        expected_port,
        _runtime=_runtime(),
    )


def _unlink_identity(dir_fd, name, identity, device):
    return _supervisor_module._unlink_identity(
        dir_fd, name, identity, device, _runtime=_runtime()
    )


def _cleanup_runtime(paths, published):
    return _supervisor_module._cleanup_runtime(
        paths, published, _runtime=_runtime()
    )


def _terminate_exact_child(child):
    return _supervisor_module._terminate_exact_child(
        child, _runtime=_runtime()
    )


def _supervisor(paths, chrome, ownership_fd, owner_fd, ready_fd):
    return _supervisor_module._supervisor(
        paths,
        chrome,
        ownership_fd,
        owner_fd,
        ready_fd,
        _runtime=_runtime(),
    )


def _remove_stale_devtools(paths):
    return _supervisor_module._remove_stale_devtools(
        paths, _runtime=_runtime()
    )


def command_start(profile, chrome_path):
    return _commands.command_start(
        profile, chrome_path, _runtime=_runtime()
    )


def command_check(profile):
    return _commands.command_check(profile, _runtime=_runtime())


def command_stop(profile):
    return _commands.command_stop(profile, _runtime=_runtime())


def _manual_profile_path(profile):
    return _commands._manual_profile_path(profile, _runtime=_runtime())


def _emit_manual_reset(profile):
    return _commands._emit_manual_reset(profile, _runtime=_runtime())


def command_reset(profile):
    return _commands.command_reset(profile, _runtime=_runtime())


def parse_args(argv):
    return _cli.parse_args(argv, _runtime=_runtime())


def main(argv=None):
    return _cli.main(argv, _runtime=_runtime())


__all__ = list(_cli.LEGACY_STAR_EXPORTS)


if __name__ == "__main__":
    sys.exit(main())
