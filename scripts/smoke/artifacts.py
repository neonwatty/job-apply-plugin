#!/usr/bin/env python3
"""Safe, deterministic inventory operations for installed smoke artifacts."""

import os
import shutil
import stat
from pathlib import Path


FIXED_CRITICAL_FILES = (
    ".codex-plugin/plugin.json",
    "scripts/job-apply-store.py",
    "scripts/job-apply-task.py",
    "scripts/job-apply-attempt.py",
    "scripts/job-apply-workspace.py",
    "skills/answer-memory/SKILL.md",
    "skills/job-apply/SKILL.md",
)
CRITICAL_TREES = (
    "scripts/job_apply_store",
    "scripts/job_apply_workspace",
    "workspace",
)


def _regular_file(root: Path, relative: str) -> Path:
    """Resolve a fixed relative artifact without following symlinks."""
    path = root / relative
    try:
        metadata = path.lstat()
    except OSError as error:
        raise SystemExit(f"critical package artifact is missing: {relative}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"critical package artifact is not a regular file: {relative}")
    return path


def critical_paths(root: Path) -> tuple[str, ...]:
    """Return the exact fixed and recursive installed-byte receipt inventory."""
    root = root.resolve(strict=True)
    paths = set(FIXED_CRITICAL_FILES)
    for relative in FIXED_CRITICAL_FILES:
        _regular_file(root, relative)
    for tree_relative in CRITICAL_TREES:
        tree = root / tree_relative
        try:
            metadata = tree.lstat()
        except OSError as error:
            raise SystemExit(f"critical package tree is missing: {tree_relative}") from error
        if not stat.S_ISDIR(metadata.st_mode):
            raise SystemExit(f"critical package tree is not a directory: {tree_relative}")
        for directory, names, filenames in os.walk(tree, followlinks=False):
            directory_path = Path(directory)
            for name in names:
                child = directory_path / name
                if child.is_symlink():
                    raise SystemExit(f"critical package tree contains a symlink: {child.relative_to(root)}")
            for filename in filenames:
                child = directory_path / filename
                relative = child.relative_to(root).as_posix()
                if child.is_symlink():
                    raise SystemExit(f"critical package tree contains a symlink: {relative}")
                _regular_file(root, relative)
                paths.add(relative)
    return tuple(sorted(paths))


def copy_critical(source: Path, target: Path) -> None:
    """Replace the target's critical artifacts with exact source bytes and modes."""
    source = source.resolve(strict=True)
    target = target.resolve(strict=True)
    for relative in critical_paths(source):
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, destination, follow_symlinks=False)


def assert_critical_bytes(installed: Path, source: Path, *, label: str) -> None:
    """Assert exact bytes for the complete critical inventory."""
    installed = installed.resolve(strict=True)
    source = source.resolve(strict=True)
    expected = critical_paths(source)
    if critical_paths(installed) != expected:
        raise SystemExit(f"{label} critical package inventory differs")
    for relative in expected:
        installed_path = _regular_file(installed, relative)
        if installed_path.read_bytes() != (source / relative).read_bytes():
            raise SystemExit(f"{label} bytes differ for {relative}")
