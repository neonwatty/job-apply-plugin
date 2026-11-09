"""Command-line launch behavior for the local workspace server."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Any

from . import LOOPBACK, runtime
from .handler import WorkspaceServer


def build_parser() -> argparse.ArgumentParser:
    store_module = runtime()["STORE_MODULE"]
    parser = argparse.ArgumentParser(
        description="Start the local Job Apply Jobs workspace"
    )
    parser.add_argument(
        "--root",
        help=(
            f"canonical store root (default: ${store_module.STORE_ENV} "
            "or ~/.job-apply)"
        ),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="loopback port (default: choose a free port)",
    )
    parser.add_argument(
        "--no-open", action="store_true", help="do not open the default browser"
    )
    parser.add_argument(
        "--json", action="store_true", help="print startup details as one JSON line"
    )
    return parser


def main() -> int:
    workspace_runtime = runtime()
    store_module = workspace_runtime["STORE_MODULE"]
    args = build_parser().parse_args()
    if not 0 <= args.port <= 65535:
        print(
            "job-apply-workspace: port must be between 0 and 65535",
            file=sys.stderr,
        )
        return 2
    configured = args.root or os.environ.get(store_module.STORE_ENV)
    store_root = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".job-apply"
    )
    try:
        server = WorkspaceServer(store_root, args.port)
    except (OSError, store_module.StoreError) as error:
        print(f"job-apply-workspace: unable to start: {error}", file=sys.stderr)
        return 2
    url = f"{server.origin}/#token={server.token}"
    details = {
        "url": url,
        "origin": server.origin,
        "host": LOOPBACK,
        "port": server.server_port,
    }
    if args.json:
        print(json.dumps(details, separators=(",", ":")), flush=True)
    else:
        print(f"Job Apply workspace: {url}", flush=True)
        print(
            "Press Ctrl-C to stop. Data stays in the canonical local store.",
            flush=True,
        )
    if not args.no_open:
        browser = workspace_runtime.get("webbrowser", webbrowser)
        threading.Timer(0.15, lambda: browser.open(url)).start()

    stopping = threading.Event()

    def stop(_signum: int | None = None, _frame: Any = None) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            signal.signal(sig, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        stop()
    finally:
        server.server_close()
    return 0
