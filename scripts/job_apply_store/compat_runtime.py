"""Live runtime binding for facade-only compatibility adapters.

Canonical domain implementations use shared primitives directly. These adapters
preserve the executable facade's historical replacement and monkeypatch seams.
Each root-local package receives its own provider, never a copied globals map.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


_provider: Callable[[], dict[str, Any]] | None = None


def bind_runtime(provider: Callable[[], dict[str, Any]]) -> None:
    global _provider
    _provider = provider


def runtime() -> dict[str, Any]:
    if _provider is None:
        raise RuntimeError("Store compatibility runtime is not bound")
    return _provider()
