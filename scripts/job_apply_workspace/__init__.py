"""Root-local implementation package for the Job Apply workspace server."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable


LOOPBACK = "127.0.0.1"
MAX_BODY_BYTES = 64 * 1024
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# Base64 is 4/3 of the decoded body. The small allowance covers the JSON
# envelope, metadata, and escaping without making ordinary routes unbounded.
MAX_UPLOAD_BODY_BYTES = ((MAX_UPLOAD_BYTES + 2) // 3) * 4 + MAX_BODY_BYTES
MAX_BULK_URLS = 50
ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = ROOT / "workspace"
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}


_RUNTIME_PROVIDER: Callable[[], dict[str, Any]] = lambda: globals()


def bind_runtime(provider: Callable[[], dict[str, Any]]) -> None:
    """Bind root-local implementation modules to the compatibility facade."""

    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


def loopback_authority(port: int) -> tuple[str, str]:
    if port == 80:
        return f"http://{LOOPBACK}", LOOPBACK
    return f"http://{LOOPBACK}:{port}", f"{LOOPBACK}:{port}"
