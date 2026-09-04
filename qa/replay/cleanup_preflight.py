"""Verified identity-tree ownership for replay cleanup."""

from __future__ import annotations

from dataclasses import dataclass
import os
import re
import stat
import sys
from typing import Any

from qa.replay.report import (
    SCENARIO_IDS,
    TOMBSTONE_KEYS,
    _report_digest,
    _validate_report,
)
from qa.replay.run_state import TOKEN
from qa.replay.secure_io import (
    CoordinatorError,
    _read_json_at,
    _same_entry,
)


MARKER_TEMP = re.compile(
    r"^\.marker-(?:abandoned|tombstone)-[a-f0-9]{32}\.tmp$"
)
IDENTIFIER = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_CLEANUP_ENTRIES = 2_000
MAX_CLEANUP_BYTES = 128 * 1024 * 1024
MAX_CLEANUP_DEPTH = 32


@dataclass(frozen=True)
class _CleanupTree:
    """One preflighted tree, bound to the exact opened run directory."""

    root_identity: os.stat_result
    manifest: dict[tuple[str, ...], os.stat_result]
    children: dict[tuple[str, ...], tuple[str, ...]]


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _assert_cleanup_tree_bound(
    directory_descriptor: int,
    tree: _CleanupTree,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        current = runtime.os.fstat(directory_descriptor)
    except OSError:
        raise CoordinatorError("run cleanup failed") from None
    if not runtime._same_entry(tree.root_identity, current):
        raise CoordinatorError("run cleanup failed")


def _preflight_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    budget: dict[str, int],
    depth: int,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    if depth > runtime.MAX_CLEANUP_DEPTH:
        raise CoordinatorError("run cleanup failed")
    try:
        names = tuple(sorted(runtime.os.listdir(directory_descriptor)))
        if len(names) > runtime.MAX_CLEANUP_ENTRIES - budget["entries"]:
            raise CoordinatorError("run cleanup failed")
        children[prefix] = names
        parent = runtime.os.fstat(directory_descriptor)
        for name in names:
            metadata = runtime.os.stat(
                name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
            is_directory = runtime.stat.S_ISDIR(metadata.st_mode)
            is_file = runtime.stat.S_ISREG(metadata.st_mode)
            expected_mode = 0o700 if is_directory else 0o600
            if (
                metadata.st_uid != runtime.os.getuid()
                or metadata.st_dev != parent.st_dev
                or not (is_directory or is_file)
                or runtime.stat.S_IMODE(metadata.st_mode) != expected_mode
            ):
                raise CoordinatorError("run cleanup failed")
            budget["entries"] += 1
            if is_file:
                budget["bytes"] += metadata.st_size
            if (
                budget["entries"] > runtime.MAX_CLEANUP_ENTRIES
                or budget["bytes"] > runtime.MAX_CLEANUP_BYTES
            ):
                raise CoordinatorError("run cleanup failed")
            flags = runtime.os.O_RDONLY | getattr(runtime.os, "O_NOFOLLOW", 0)
            if is_directory:
                flags |= runtime.os.O_DIRECTORY
            opened = runtime.os.open(
                name, flags, dir_fd=directory_descriptor
            )
            try:
                if not runtime._same_entry(metadata, runtime.os.fstat(opened)):
                    raise CoordinatorError("run cleanup failed")
                path = prefix + (name,)
                manifest[path] = metadata
                if is_directory:
                    runtime._preflight_cleanup_tree(
                        opened,
                        path,
                        manifest,
                        children,
                        budget,
                        depth + 1,
                    )
            finally:
                runtime.os.close(opened)
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


def _build_cleanup_tree(
    directory_descriptor: int, *, _runtime: Any | None = None
) -> _CleanupTree:
    runtime = _resolve_runtime(_runtime)
    try:
        root_identity = runtime.os.fstat(directory_descriptor)
    except OSError:
        raise CoordinatorError("run cleanup failed") from None
    manifest: dict[tuple[str, ...], os.stat_result] = {}
    children: dict[tuple[str, ...], tuple[str, ...]] = {}
    runtime._preflight_cleanup_tree(
        directory_descriptor,
        (),
        manifest,
        children,
        {"entries": 0, "bytes": 0},
        0,
    )
    return _CleanupTree(root_identity, manifest, children)


def _sanitize_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    retained: set[tuple[str, ...]],
    deferred: set[tuple[str, ...]],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        expected_names = children[prefix]
        if tuple(sorted(runtime.os.listdir(directory_descriptor))) != expected_names:
            raise CoordinatorError("run cleanup failed")
        for name in expected_names:
            path = prefix + (name,)
            expected = manifest[path]
            current = runtime.os.stat(
                name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
            if not runtime._same_entry(expected, current):
                raise CoordinatorError("run cleanup failed")
            if path in deferred:
                continue
            is_directory = runtime.stat.S_ISDIR(expected.st_mode)
            flags = (
                runtime.os.O_RDONLY
                if is_directory or path in retained
                else runtime.os.O_WRONLY
            )
            flags |= getattr(runtime.os, "O_NOFOLLOW", 0)
            if is_directory:
                flags |= runtime.os.O_DIRECTORY
            opened = runtime.os.open(
                name, flags, dir_fd=directory_descriptor
            )
            try:
                if not runtime._same_entry(expected, runtime.os.fstat(opened)):
                    raise CoordinatorError("run cleanup failed")
                if is_directory:
                    runtime._sanitize_cleanup_tree(
                        opened,
                        path,
                        manifest,
                        children,
                        retained,
                        deferred,
                    )
                elif path not in retained:
                    runtime.os.ftruncate(opened, 0)
                    runtime.os.fsync(opened)
            finally:
                runtime.os.close(opened)
        if tuple(sorted(runtime.os.listdir(directory_descriptor))) != expected_names:
            raise CoordinatorError("run cleanup failed")
        for name in expected_names:
            if not runtime._same_entry(
                manifest[prefix + (name,)],
                runtime.os.stat(
                    name,
                    dir_fd=directory_descriptor,
                    follow_symlinks=False,
                ),
            ):
                raise CoordinatorError("run cleanup failed")
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


def _sanitize_deferred_regular(
    directory_descriptor: int,
    name: str,
    expected: os.stat_result,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    descriptor = None
    try:
        current = runtime.os.stat(
            name, dir_fd=directory_descriptor, follow_symlinks=False
        )
        if not runtime.stat.S_ISREG(expected.st_mode) or not runtime._same_entry(
            expected, current
        ):
            raise CoordinatorError("run cleanup failed")
        descriptor = runtime.os.open(
            name,
            runtime.os.O_WRONLY | getattr(runtime.os, "O_NOFOLLOW", 0),
            dir_fd=directory_descriptor,
        )
        if not runtime._same_entry(expected, runtime.os.fstat(descriptor)):
            raise CoordinatorError("run cleanup failed")
        runtime.os.ftruncate(descriptor, 0)
        runtime.os.fsync(descriptor)
        runtime.os.close(descriptor)
        descriptor = None
        if not runtime._same_entry(
            expected,
            runtime.os.stat(
                name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            ),
        ):
            raise CoordinatorError("run cleanup failed")
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError("run cleanup failed") from None
    finally:
        if descriptor is not None:
            runtime.os.close(descriptor)


def _verify_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    retained: set[tuple[str, ...]],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        expected_names = children[prefix]
        if tuple(sorted(runtime.os.listdir(directory_descriptor))) != expected_names:
            raise CoordinatorError("run cleanup failed")
        for name in expected_names:
            path = prefix + (name,)
            expected = manifest[path]
            current = runtime.os.stat(
                name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
            if not runtime._same_entry(expected, current):
                raise CoordinatorError("run cleanup failed")
            is_directory = runtime.stat.S_ISDIR(expected.st_mode)
            flags = runtime.os.O_RDONLY | getattr(runtime.os, "O_NOFOLLOW", 0)
            if is_directory:
                flags |= runtime.os.O_DIRECTORY
            opened = runtime.os.open(
                name, flags, dir_fd=directory_descriptor
            )
            try:
                opened_metadata = runtime.os.fstat(opened)
                if not runtime._same_entry(expected, opened_metadata):
                    raise CoordinatorError("run cleanup failed")
                if is_directory:
                    runtime._verify_cleanup_tree(
                        opened,
                        path,
                        manifest,
                        children,
                        retained,
                    )
                elif path not in retained and opened_metadata.st_size != 0:
                    raise CoordinatorError("run cleanup failed")
            finally:
                runtime.os.close(opened)
        if tuple(sorted(runtime.os.listdir(directory_descriptor))) != expected_names:
            raise CoordinatorError("run cleanup failed")
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


def _sanitize_run_artifacts(
    run_descriptor: int,
    *,
    retain_report: bool,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    retained = {"tombstone.json"}
    if retain_report:
        retained.add("report.json")
    allowed_files = {
        "fixture.json",
        "profile.json",
        "synthetic-resume.pdf",
        "expected.json",
        "run.json",
        "lifecycle.json",
        "completed.json",
        "abandoned.json",
        "report.json",
        "evaluate.lock",
        "lifecycle-transition.lock",
        "tombstone.json",
    }
    tree = _build_cleanup_tree(run_descriptor, _runtime=runtime)
    if any(
        path[0] != "store"
        and path[0] not in allowed_files
        and runtime.MARKER_TEMP.fullmatch(path[0]) is None
        for path in tree.manifest
    ):
        raise CoordinatorError("run cleanup failed")
    for path, metadata in tree.manifest.items():
        if len(path) != 1:
            continue
        if path[0] == "store":
            if not runtime.stat.S_ISDIR(metadata.st_mode):
                raise CoordinatorError("run cleanup failed")
        elif not runtime.stat.S_ISREG(metadata.st_mode):
            raise CoordinatorError("run cleanup failed")
    retained_paths = {(name,) for name in retained}
    deferred_paths = (
        {("run.json",)}
        if ("run.json",) in tree.manifest
        and ("run.json",) not in retained_paths
        else set()
    )
    _assert_cleanup_tree_bound(run_descriptor, tree, _runtime=runtime)
    runtime._sanitize_cleanup_tree(
        run_descriptor,
        (),
        tree.manifest,
        tree.children,
        retained_paths,
        deferred_paths,
    )
    _assert_cleanup_tree_bound(run_descriptor, tree, _runtime=runtime)
    runtime._verify_cleanup_tree(
        run_descriptor,
        (),
        tree.manifest,
        tree.children,
        retained_paths | deferred_paths,
    )
    for path in sorted(deferred_paths):
        runtime._sanitize_deferred_regular(
            run_descriptor, path[0], tree.manifest[path]
        )
    _assert_cleanup_tree_bound(run_descriptor, tree, _runtime=runtime)
    runtime._verify_cleanup_tree(
        run_descriptor, (), tree.manifest, tree.children, retained_paths
    )
    try:
        runtime.os.fsync(run_descriptor)
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


def _validate_self_contained_tombstone(
    run_descriptor: int,
    run_id: str,
    tombstone: Any,
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    if (
        not isinstance(tombstone, dict)
        or set(tombstone) != runtime.TOMBSTONE_KEYS
        or tombstone.get("runId") != run_id
        or tombstone.get("state") not in {"abandoned", "completed"}
        or not isinstance(tombstone.get("reportRetained"), bool)
        or tombstone["reportRetained"] != (tombstone["state"] == "completed")
        or runtime.TOKEN.fullmatch(tombstone.get("lifecycleNonce", "")) is None
        or runtime.IDENTIFIER.fullmatch(tombstone.get("fixtureId", "")) is None
        or tombstone.get("scenarioId") not in runtime.SCENARIO_IDS
        or runtime.TOKEN.fullmatch(tombstone.get("mac", "")) is None
    ):
        raise CoordinatorError("invalid cleanup state")
    if tombstone["reportRetained"]:
        report = runtime._read_json_at(
            run_descriptor, "report.json", "invalid run report"
        )
        missing = report.get("missingControlIds") if isinstance(report, dict) else None
        if not isinstance(missing, list) or not all(
            isinstance(value, str)
            and runtime.re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", value)
            for value in missing
        ):
            raise CoordinatorError("invalid run report")
        fixture = {
            "steps": [
                {
                    "controls": [
                        {"id": value, "required": True} for value in missing
                    ]
                }
            ]
        }
        runtime._validate_report(
            report,
            {
                "fixtureId": tombstone["fixtureId"],
                "scenarioId": tombstone["scenarioId"],
            },
            fixture,
        )
        if tombstone.get("reportSha256") != runtime._report_digest(report):
            raise CoordinatorError("invalid run report")
    elif tombstone.get("reportSha256") is not None:
        raise CoordinatorError("invalid cleanup state")

    tree = _build_cleanup_tree(run_descriptor, _runtime=runtime)
    allowed_top = {
        "fixture.json",
        "profile.json",
        "synthetic-resume.pdf",
        "expected.json",
        "run.json",
        "lifecycle.json",
        "completed.json",
        "abandoned.json",
        "report.json",
        "evaluate.lock",
        "lifecycle-transition.lock",
        "tombstone.json",
    }
    retained = {("tombstone.json",)}
    if tombstone["reportRetained"]:
        retained.add(("report.json",))
    for path, metadata in tree.manifest.items():
        if (
            path[0] != "store"
            and path[0] not in allowed_top
            and runtime.MARKER_TEMP.fullmatch(path[0]) is None
        ):
            raise CoordinatorError("invalid cleanup state")
        if len(path) == 1:
            if path[0] == "store" and not runtime.stat.S_ISDIR(metadata.st_mode):
                raise CoordinatorError("invalid cleanup state")
            if path[0] != "store" and not runtime.stat.S_ISREG(metadata.st_mode):
                raise CoordinatorError("invalid cleanup state")
        if (
            runtime.stat.S_ISREG(metadata.st_mode)
            and path not in retained
            and metadata.st_size
        ):
            raise CoordinatorError("invalid cleanup state")
    return tombstone
