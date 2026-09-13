"""Identity-bound rollback for an installed promotion fixture."""

from __future__ import annotations

import os
import stat
import sys
from typing import Any

from qa.promotion.bindings import PromotionError, _same_identity
from qa.promotion.deletion import _remove_tree_contents
from qa.promotion.destination import _DestinationBinding


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _rollback_installed_fixture(
    destination: _DestinationBinding,
    fixture_id: str,
    installed_identity: os.stat_result,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    target_descriptor = None
    try:
        current = runtime.os.stat(
            fixture_id,
            dir_fd=destination.destination_descriptor,
            follow_symlinks=False,
        )
        if not runtime._same_identity(
            installed_identity, current
        ) or not runtime.stat.S_ISDIR(current.st_mode):
            raise PromotionError("promotion rollback failed")
        target_descriptor = runtime.os.open(
            fixture_id,
            runtime.os.O_RDONLY
            | runtime.os.O_DIRECTORY
            | runtime.os.O_NOFOLLOW
            | runtime.os.O_CLOEXEC,
            dir_fd=destination.destination_descriptor,
        )
        if not runtime._same_identity(
            installed_identity, runtime.os.fstat(target_descriptor)
        ):
            raise PromotionError("promotion rollback failed")
        runtime._remove_tree_contents(target_descriptor)
        runtime.os.close(target_descriptor)
        target_descriptor = None
        current = runtime.os.stat(
            fixture_id,
            dir_fd=destination.destination_descriptor,
            follow_symlinks=False,
        )
        if not runtime._same_identity(installed_identity, current):
            raise PromotionError("promotion rollback failed")
        runtime.os.rmdir(
            fixture_id, dir_fd=destination.destination_descriptor
        )
        runtime.os.fsync(destination.destination_descriptor)
    except (PromotionError, OSError, MemoryError):
        raise PromotionError("promotion rollback failed") from None
    finally:
        if target_descriptor is not None:
            runtime.os.close(target_descriptor)
