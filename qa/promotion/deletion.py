"""Preflighted descriptor-relative deletion for private promotion sessions."""

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
    _darwin_mountpoint_bound,
    _descriptor_mount_identity,
    _same_identity,
)


MAX_DELETE_DEPTH = 32
MAX_DELETE_ENTRIES = 4096
MAX_DELETE_ENTRIES_PER_DIRECTORY = 1024


@dataclass
class _DeleteNode:
    name: str
    identity: os.stat_result
    children: list["_DeleteNode"] | None


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _deletion_entry_identity(entry: os.DirEntry[str]) -> os.stat_result:
    return entry.stat(follow_symlinks=False)


def _remove_tree_contents(
    directory_descriptor: int,
    *,
    depth: int = 0,
    state: list[int] | None = None,
    device: int | None = None,
    mount_identity: tuple[int, int] | None = None,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    if state is None:
        state = [0]
    if depth > runtime.MAX_DELETE_DEPTH:
        raise PromotionError("bounded cleanup failed")
    if device is None:
        device = runtime.os.fstat(directory_descriptor).st_dev
    if mount_identity is None:
        mount_identity = runtime._descriptor_mount_identity(directory_descriptor)
    per_directory = 0
    with runtime.os.scandir(directory_descriptor) as entries:
        for entry in entries:
            per_directory += 1
            state[0] += 1
            if (
                per_directory > runtime.MAX_DELETE_ENTRIES_PER_DIRECTORY
                or state[0] > runtime.MAX_DELETE_ENTRIES
            ):
                raise PromotionError("bounded cleanup failed")
            identity = entry.stat(follow_symlinks=False)
            if identity.st_dev != device:
                raise PromotionError("bounded cleanup failed")
            if runtime.stat.S_ISDIR(identity.st_mode) and not runtime.stat.S_ISLNK(
                identity.st_mode
            ):
                child = runtime.os.open(
                    entry.name,
                    runtime.os.O_RDONLY
                    | runtime.os.O_DIRECTORY
                    | runtime.os.O_NOFOLLOW
                    | runtime.os.O_CLOEXEC,
                    dir_fd=directory_descriptor,
                )
                try:
                    if not runtime._same_identity(
                        identity, runtime.os.fstat(child)
                    ):
                        raise PromotionError("bounded cleanup failed")
                    if runtime._descriptor_mount_identity(child) != mount_identity:
                        raise PromotionError("bounded cleanup failed")
                    runtime._remove_tree_contents(
                        child,
                        depth=depth + 1,
                        state=state,
                        device=device,
                        mount_identity=mount_identity,
                    )
                finally:
                    runtime.os.close(child)
                runtime.os.rmdir(entry.name, dir_fd=directory_descriptor)
            elif runtime.stat.S_ISREG(identity.st_mode) or runtime.stat.S_ISLNK(
                identity.st_mode
            ):
                runtime.os.unlink(entry.name, dir_fd=directory_descriptor)
            else:
                raise PromotionError("bounded cleanup failed")


def _remove_child_tree(
    parent_descriptor: int, name: str, *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    child = runtime.os.open(
        name,
        runtime.os.O_RDONLY | runtime.os.O_DIRECTORY | runtime.os.O_NOFOLLOW,
        dir_fd=parent_descriptor,
    )
    try:
        runtime._remove_tree_contents(child)
    finally:
        runtime.os.close(child)
    runtime.os.rmdir(name, dir_fd=parent_descriptor)


def _preflight_deletion(
    binding: _PrivateBinding, *, _runtime: Any | None = None
) -> list[_DeleteNode]:
    runtime = _resolve_runtime(_runtime)
    total = 0
    session_device = binding.session_identity.st_dev

    def walk(
        directory_descriptor: int, depth: int, directory_path: Path
    ) -> list[_DeleteNode]:
        nonlocal total
        if depth > runtime.MAX_DELETE_DEPTH:
            raise PromotionError("deletion preflight failed")
        nodes: list[_DeleteNode] = []
        per_directory = 0
        try:
            with runtime.os.scandir(directory_descriptor) as entries:
                for entry in entries:
                    per_directory += 1
                    total += 1
                    if (
                        per_directory > runtime.MAX_DELETE_ENTRIES_PER_DIRECTORY
                        or total > runtime.MAX_DELETE_ENTRIES
                    ):
                        raise PromotionError("deletion preflight failed")
                    identity = runtime._deletion_entry_identity(entry)
                    if identity.st_dev != session_device:
                        raise PromotionError("deletion preflight failed")
                    if runtime.stat.S_ISDIR(identity.st_mode):
                        child = runtime.os.open(
                            entry.name,
                            runtime.os.O_RDONLY
                            | runtime.os.O_DIRECTORY
                            | runtime.os.O_NOFOLLOW
                            | runtime.os.O_CLOEXEC,
                            dir_fd=directory_descriptor,
                        )
                        try:
                            opened = runtime.os.fstat(child)
                            if (
                                not runtime._same_identity(identity, opened)
                                or opened.st_dev != session_device
                                or runtime._descriptor_mount_identity(child)
                                != binding.mount_identity
                                or runtime._darwin_mountpoint_bound(
                                    directory_path / entry.name,
                                    identity,
                                    child,
                                )
                            ):
                                raise PromotionError("deletion preflight failed")
                            children = walk(
                                child, depth + 1, directory_path / entry.name
                            )
                        finally:
                            runtime.os.close(child)
                        nodes.append(runtime._DeleteNode(entry.name, identity, children))
                    elif runtime.stat.S_ISREG(identity.st_mode):
                        child = runtime.os.open(
                            entry.name,
                            runtime.os.O_RDONLY
                            | runtime.os.O_NOFOLLOW
                            | runtime.os.O_CLOEXEC,
                            dir_fd=directory_descriptor,
                        )
                        try:
                            if (
                                not runtime._same_identity(
                                    identity, runtime.os.fstat(child)
                                )
                                or runtime._descriptor_mount_identity(child)
                                != binding.mount_identity
                                or runtime._darwin_mountpoint_bound(
                                    directory_path / entry.name,
                                    identity,
                                    child,
                                )
                            ):
                                raise PromotionError("deletion preflight failed")
                        finally:
                            runtime.os.close(child)
                        nodes.append(runtime._DeleteNode(entry.name, identity, None))
                    elif runtime.stat.S_ISLNK(identity.st_mode):
                        nodes.append(runtime._DeleteNode(entry.name, identity, None))
                    else:
                        raise PromotionError("deletion preflight failed")
        except PromotionError:
            raise
        except (OSError, MemoryError, RecursionError):
            raise PromotionError("deletion preflight failed") from None
        return nodes

    runtime._assert_private_binding(binding)
    return walk(binding.session_descriptor, 0, binding.session)


def _delete_preflighted(
    directory_descriptor: int,
    nodes: list[_DeleteNode],
    session_device: int,
    mount_identity: tuple[int, int],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        for node in nodes:
            current = runtime.os.stat(
                node.name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
            if (
                not runtime._same_identity(node.identity, current)
                or current.st_mode != node.identity.st_mode
                or current.st_dev != session_device
            ):
                raise PromotionError("private session deletion failed")
            if node.children is not None:
                child = runtime.os.open(
                    node.name,
                    runtime.os.O_RDONLY
                    | runtime.os.O_DIRECTORY
                    | runtime.os.O_NOFOLLOW
                    | runtime.os.O_CLOEXEC,
                    dir_fd=directory_descriptor,
                )
                try:
                    if not runtime._same_identity(
                        node.identity, runtime.os.fstat(child)
                    ):
                        raise PromotionError("private session deletion failed")
                    if runtime._descriptor_mount_identity(child) != mount_identity:
                        raise PromotionError("private session deletion failed")
                    runtime._delete_preflighted(
                        child, node.children, session_device, mount_identity
                    )
                finally:
                    runtime.os.close(child)
                runtime.os.rmdir(node.name, dir_fd=directory_descriptor)
            else:
                runtime.os.unlink(node.name, dir_fd=directory_descriptor)
    except PromotionError:
        raise
    except (OSError, MemoryError, RecursionError):
        raise PromotionError("private session deletion failed") from None


def _destroy_bound_session(
    binding: _PrivateBinding,
    deletion_plan: list[_DeleteNode],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        runtime._assert_private_binding(binding)
        runtime._delete_preflighted(
            binding.session_descriptor,
            deletion_plan,
            binding.session_identity.st_dev,
            binding.mount_identity,
        )
        named_session = runtime.os.stat(
            binding.session.name,
            dir_fd=binding.private_descriptor,
            follow_symlinks=False,
        )
        if not runtime._same_identity(binding.session_identity, named_session):
            raise PromotionError("private session deletion failed")
        runtime.os.rmdir(
            binding.session.name, dir_fd=binding.private_descriptor
        )
    except PromotionError:
        raise
    except (OSError, ValueError):
        raise PromotionError("private session deletion failed") from None
