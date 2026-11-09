"""Descriptor-bound destination validation and staging writes."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import stat
import sys
from typing import Any

from qa.promotion.bindings import (
    PromotionError,
    _PrivateBinding,
    _assert_private_binding,
    _same_identity,
)


@dataclass
class _DestinationBinding:
    root: Path
    destination: Path
    root_descriptor: int
    qa_descriptor: int
    destination_descriptor: int
    root_identity: os.stat_result
    qa_identity: os.stat_result
    destination_identity: os.stat_result

    def close(self) -> None:
        os.close(self.destination_descriptor)
        os.close(self.qa_descriptor)
        os.close(self.root_descriptor)


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _open_destination_binding(
    destination_argument: Path, *, _runtime: Any | None = None
) -> _DestinationBinding:
    runtime = _resolve_runtime(_runtime)
    destination = runtime.Path(runtime.os.path.abspath(destination_argument))
    if destination.name != "fixtures" or destination.parent.name != "qa":
        raise PromotionError("unsafe destination path")
    root = destination.parent.parent
    root_descriptor = qa_descriptor = destination_descriptor = None
    binding = None
    try:
        root_identity = root.lstat()
        if not runtime.stat.S_ISDIR(root_identity.st_mode) or runtime.stat.S_ISLNK(
            root_identity.st_mode
        ):
            raise PromotionError("unsafe destination path")
        root_descriptor = runtime.os.open(
            root,
            runtime.os.O_RDONLY
            | runtime.os.O_DIRECTORY
            | runtime.os.O_NOFOLLOW
            | runtime.os.O_CLOEXEC,
        )
        if not runtime._same_identity(
            root_identity, runtime.os.fstat(root_descriptor)
        ):
            raise PromotionError("unsafe destination path")
        qa_identity = runtime.os.stat(
            "qa", dir_fd=root_descriptor, follow_symlinks=False
        )
        qa_descriptor = runtime.os.open(
            "qa",
            runtime.os.O_RDONLY
            | runtime.os.O_DIRECTORY
            | runtime.os.O_NOFOLLOW
            | runtime.os.O_CLOEXEC,
            dir_fd=root_descriptor,
        )
        if not runtime._same_identity(
            qa_identity, runtime.os.fstat(qa_descriptor)
        ):
            raise PromotionError("unsafe destination path")
        destination_identity = runtime.os.stat(
            "fixtures", dir_fd=qa_descriptor, follow_symlinks=False
        )
        destination_descriptor = runtime.os.open(
            "fixtures",
            runtime.os.O_RDONLY
            | runtime.os.O_DIRECTORY
            | runtime.os.O_NOFOLLOW
            | runtime.os.O_CLOEXEC,
            dir_fd=qa_descriptor,
        )
        if not runtime._same_identity(
            destination_identity, runtime.os.fstat(destination_descriptor)
        ):
            raise PromotionError("unsafe destination path")
        binding = runtime._DestinationBinding(
            root,
            destination,
            root_descriptor,
            qa_descriptor,
            destination_descriptor,
            root_identity,
            qa_identity,
            destination_identity,
        )
        return binding
    except PromotionError:
        raise
    except (OSError, ValueError, RuntimeError):
        raise PromotionError("unsafe destination path") from None
    finally:
        if binding is None:
            if destination_descriptor is not None:
                runtime.os.close(destination_descriptor)
            if qa_descriptor is not None:
                runtime.os.close(qa_descriptor)
            if root_descriptor is not None:
                runtime.os.close(root_descriptor)


def _assert_destination_binding(
    binding: _DestinationBinding, *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        if not runtime._same_identity(binding.root_identity, binding.root.lstat()):
            raise PromotionError("unsafe destination path")
        named_qa = runtime.os.stat(
            "qa", dir_fd=binding.root_descriptor, follow_symlinks=False
        )
        named_destination = runtime.os.stat(
            "fixtures", dir_fd=binding.qa_descriptor, follow_symlinks=False
        )
        if (
            not runtime._same_identity(
                binding.root_identity, runtime.os.fstat(binding.root_descriptor)
            )
            or not runtime._same_identity(binding.qa_identity, named_qa)
            or not runtime._same_identity(
                binding.qa_identity, runtime.os.fstat(binding.qa_descriptor)
            )
            or not runtime._same_identity(
                binding.destination_identity, named_destination
            )
            or not runtime._same_identity(
                binding.destination_identity,
                runtime.os.fstat(binding.destination_descriptor),
            )
        ):
            raise PromotionError("unsafe destination path")
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("unsafe destination path") from None


def _reject_overlap(
    private: _PrivateBinding,
    destination: _DestinationBinding,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    runtime._assert_private_binding(private)
    runtime._assert_destination_binding(destination)
    try:
        destination_text = str(destination.destination.resolve(strict=True))
        for protected in (private.private, private.session, private.candidate):
            protected_text = str(protected.resolve(strict=True))
            if (
                runtime.os.path.commonpath((destination_text, protected_text))
                == protected_text
            ):
                raise PromotionError("unsafe destination path")
        protected_identities = {
            (private.private_identity.st_dev, private.private_identity.st_ino),
            (private.session_identity.st_dev, private.session_identity.st_ino),
            (private.candidate_identity.st_dev, private.candidate_identity.st_ino),
        }
        destination_identities = {
            (destination.root_identity.st_dev, destination.root_identity.st_ino),
            (destination.qa_identity.st_dev, destination.qa_identity.st_ino),
            (
                destination.destination_identity.st_dev,
                destination.destination_identity.st_ino,
            ),
        }
        if protected_identities & destination_identities:
            raise PromotionError("unsafe destination path")
    except (OSError, RuntimeError, ValueError):
        raise PromotionError("unsafe destination path") from None


def _write_staging_file(
    directory_descriptor: int,
    name: str,
    content: bytes,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    descriptor = runtime.os.open(
        name,
        runtime.os.O_WRONLY
        | runtime.os.O_CREAT
        | runtime.os.O_EXCL
        | runtime.os.O_NOFOLLOW,
        0o644,
        dir_fd=directory_descriptor,
    )
    try:
        view = memoryview(content)
        while view:
            written = runtime.os.write(descriptor, view)
            view = view[written:]
        runtime.os.fsync(descriptor)
    finally:
        runtime.os.close(descriptor)
