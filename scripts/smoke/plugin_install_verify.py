#!/usr/bin/env python3
"""Verify isolated Claude and Codex plugin installations."""

import argparse
import json
from pathlib import Path

from artifacts import assert_critical_bytes


EXPECTED_SKILLS = {
    "answer-memory",
    "job-apply",
    "job-search",
    "job-preferences",
    "job-workspace",
}


def verify_claude(plugin_list: Path) -> None:
    plugins = json.loads(plugin_list.resolve(strict=True).read_text(encoding="utf-8"))
    if "job-apply@neonwatty-plugins" not in json.dumps(plugins):
        raise SystemExit("isolated plugin list does not contain job-apply@neonwatty-plugins")
    print("Isolated Claude Code marketplace install passed")


def verify_codex(plugin_list: Path, codex_home: Path, source: Path) -> None:
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
    args = parser.parse_args()
    if args.action == "claude":
        verify_claude(args.plugin_list)
    else:
        verify_codex(args.plugin_list, args.codex_home, args.source)


if __name__ == "__main__":
    main()
