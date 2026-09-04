#!/usr/bin/env python3
"""Verify isolated Codex old-to-new plugin upgrades."""

import argparse
import json
from pathlib import Path

from artifacts import assert_critical_bytes


def verify_prior(codex_home: Path) -> None:
    cache = (
        codex_home.resolve(strict=True)
        / "plugins" / "cache" / "neonwatty-plugins" / "job-apply" / "1.1.0"
    )
    if cache.name != "1.1.0" or not cache.is_dir():
        raise SystemExit("isolated prior Codex version directory was not selected")
    sentinel = (cache / "scripts" / "job-apply-store.py").read_text(encoding="utf-8")
    if sentinel != "# isolated-old-version-sentinel\n":
        raise SystemExit("isolated prior Codex sentinel bytes were not installed")
    print("Isolated prior Codex package installed")


def verify_upgrade(plugin_list: Path, codex_home: Path, source: Path) -> None:
    plugins = json.loads(plugin_list.resolve(strict=True).read_text(encoding="utf-8"))
    match = next(
        (
            plugin
            for plugin in plugins.get("installed", [])
            if plugin.get("pluginId") == "job-apply@neonwatty-plugins"
        ),
        None,
    )
    if not match or not match.get("enabled"):
        raise SystemExit("isolated upgraded Codex plugin is not selected")
    source = source.resolve(strict=True)
    version = json.loads(
        (source / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
    )["version"]
    if match.get("version") != version:
        raise SystemExit("isolated upgraded Codex selection does not match the manifest version")
    installed = (
        codex_home.resolve(strict=True)
        / "plugins" / "cache" / "neonwatty-plugins" / "job-apply" / version
    )
    if installed.name != version or not installed.is_dir():
        raise SystemExit("upgraded Codex version directory does not match the manifest")
    assert_critical_bytes(installed, source, label="upgraded Codex")
    if b"isolated-old-version-sentinel" in (
        installed / "scripts" / "job-apply-store.py"
    ).read_bytes():
        raise SystemExit("upgraded Codex package retained prior sentinel bytes")
    print("Isolated Codex old-to-new replacement and critical-byte parity passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)
    prior = subparsers.add_parser("prior")
    prior.add_argument("codex_home", type=Path)
    upgrade = subparsers.add_parser("upgrade")
    upgrade.add_argument("plugin_list", type=Path)
    upgrade.add_argument("codex_home", type=Path)
    upgrade.add_argument("source", type=Path)
    args = parser.parse_args()
    if args.action == "prior":
        verify_prior(args.codex_home)
    else:
        verify_upgrade(args.plugin_list, args.codex_home, args.source)


if __name__ == "__main__":
    main()
