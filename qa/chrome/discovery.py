"""Chrome executable discovery and exact loopback CDP probing."""

import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.parse

from .paths import MAX_BODY, REQUEST_TIMEOUT, fail


def _resolve_runtime(runtime):
    return sys.modules[__name__] if runtime is None else runtime


def discover_chrome(explicit, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    if explicit is not None:
        candidate = runtime.Path(explicit)
        if not candidate.is_absolute():
            runtime.fail("invalid Chrome executable")
        try:
            st = runtime.os.lstat(str(candidate))
        except OSError:
            runtime.fail("invalid Chrome executable")
        if (
            not runtime.stat.S_ISREG(st.st_mode)
            or st.st_uid != runtime.os.getuid()
            or not st.st_mode & 0o111
        ):
            runtime.fail("invalid Chrome executable")
        return str(candidate), st.st_dev, st.st_ino
    if runtime.sys.platform != "darwin":
        runtime.fail("unsupported platform")
    for candidate in (
        runtime.Path(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        ),
        runtime.Path(
            runtime.os.path.expanduser(
                "~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            )
        ),
    ):
        try:
            st = runtime.os.lstat(str(candidate))
        except OSError:
            continue
        if runtime.stat.S_ISREG(st.st_mode) and st.st_mode & 0o111:
            return str(candidate), st.st_dev, st.st_ino
    runtime.fail("Chrome executable not found")


def _browser_path_hash(browser_path, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    return runtime.hashlib.sha256(browser_path.encode("ascii")).hexdigest()


def _cdp_browser_path(port, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    if not isinstance(port, int) or not 0 < port < 65536:
        return None
    connection = runtime.http.client.HTTPConnection(
        "127.0.0.1", port, timeout=runtime.REQUEST_TIMEOUT
    )
    try:
        connection.request(
            "GET", "/json/version", headers={"Host": "127.0.0.1:%d" % port}
        )
        response = connection.getresponse()
        body = response.read(runtime.MAX_BODY + 1)
        if response.status != 200 or len(body) > runtime.MAX_BODY:
            return None
        value = runtime.json.loads(body.decode("utf-8"))
        if not isinstance(value, dict) or not isinstance(
            value.get("Protocol-Version"), str
        ):
            return None
        websocket = value.get("webSocketDebuggerUrl")
        if not isinstance(websocket, str):
            return None
        parsed = runtime.urllib.parse.urlsplit(websocket)
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
        if not runtime.re.fullmatch(
            r"/devtools/browser/[A-Za-z0-9._-]+", parsed.path
        ):
            return None
        return parsed.path
    except (
        OSError,
        http.client.HTTPException,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        return None
    finally:
        connection.close()


def _probe_cdp(
    port, browser_path=None, browser_path_hash=None, *, _runtime=None
):
    runtime = _resolve_runtime(_runtime)
    observed = runtime._cdp_browser_path(port)
    if observed is None:
        return False
    if browser_path is not None and observed != browser_path:
        return False
    if browser_path_hash is not None and not runtime.hmac.compare_digest(
        runtime._browser_path_hash(observed), browser_path_hash
    ):
        return False
    return True
