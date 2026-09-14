#!/usr/bin/env python3
"""Verify isolated Claude and Codex plugin installations."""

from __future__ import annotations

import argparse
import json
import os
import stat
from pathlib import Path

from artifacts import assert_critical_bytes


EXPECTED_SKILLS = {
    "answer-memory",
    "job-apply",
    "job-search",
    "job-preferences",
    "job-workspace",
}


def packaged_lock_files(root: Path) -> dict[str, bytes]:
    tree = root.resolve(strict=True) / "native" / "packaged-lock"
    metadata = tree.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit("packaged native lock tree is invalid")
    files = {}
    for directory, names, filenames in os.walk(tree, followlinks=False):
        current = Path(directory)
        for name in names:
            if (current / name).is_symlink():
                raise SystemExit("packaged native lock tree contains a symlink")
        for name in filenames:
            path = current / name
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise SystemExit("packaged native lock tree contains a non-regular file")
            files[path.relative_to(tree).as_posix()] = path.read_bytes()
    return files


def verify_claude(plugin_list: Path) -> None:
    plugins = json.loads(plugin_list.resolve(strict=True).read_text(encoding="utf-8"))
    if "job-apply@neonwatty-plugins" not in json.dumps(plugins):
        raise SystemExit("isolated plugin list does not contain job-apply@neonwatty-plugins")
    print("Isolated Claude Code marketplace install passed")


def verify_codex(
    plugin_list: Path, codex_home: Path, source: Path, installed_root_output: Path | None
) -> None:
    plugins = json.loads(plugin_list.resolve(strict=True).read_text(encoding="utf-8"))
    installed = plugins.get("installed", [])
    match = next(
        (
            plugin
            for plugin in installed
            if plugin.get("pluginId") == "job-apply@neonwatty-plugins"
        ),
        None,
    )
    if not match or not match.get("enabled"):
        raise SystemExit("isolated Codex plugin list does not contain an enabled job-apply plugin")
    cache_root = (
        codex_home.resolve(strict=True)
        / "plugins" / "cache" / "neonwatty-plugins" / "job-apply"
    )
    versions = [path for path in cache_root.iterdir() if path.is_dir()]
    if len(versions) != 1:
        raise SystemExit(f"expected one isolated Codex plugin version, found {len(versions)}")
    source = source.resolve(strict=True)
    manifest_version = json.loads(
        (source / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
    )["version"]
    if match.get("version") != manifest_version:
        raise SystemExit("installed Codex selection does not match the manifest version")
    if versions[0].name != manifest_version:
        raise SystemExit("installed Codex version directory does not match the manifest")
    installed_skills = {
        path.name for path in (versions[0] / "skills").iterdir() if path.is_dir()
    }
    if installed_skills != EXPECTED_SKILLS:
        raise SystemExit(
            f"installed Codex skill inventory differs: expected {sorted(EXPECTED_SKILLS)}, "
            f"got {sorted(installed_skills)}"
        )
    assert_critical_bytes(versions[0], source, label="installed Codex")
    if packaged_lock_files(versions[0]) != packaged_lock_files(source):
        raise SystemExit("installed Codex packaged native lock bytes differ")
    if installed_root_output is not None:
        installed_root_output.write_text(str(versions[0].resolve(strict=True)) + "\n", encoding="utf-8")
    print("Isolated Codex marketplace install and critical-byte parity passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)
    claude = subparsers.add_parser("claude")
    claude.add_argument("plugin_list", type=Path)
    codex = subparsers.add_parser("codex")
    codex.add_argument("plugin_list", type=Path)
    codex.add_argument("codex_home", type=Path)
    codex.add_argument("source", type=Path)
    codex.add_argument("--installed-root-output", type=Path)
    args = parser.parse_args()
    if args.action == "claude":
        verify_claude(args.plugin_list)
    else:
        verify_codex(args.plugin_list, args.codex_home, args.source, args.installed_root_output)


if __name__ == "__main__":
    main()
