#!/usr/bin/env python3
"""Build and verify isolated plugin fixtures for the smoke harness."""

import argparse
import json
import os
import stat
from pathlib import Path

from artifacts import copy_critical


EXCLUDED_PATHS = (
    ".git",
    ".qa-private",
    "qa/runs",
    ".job-apply-qa",
    "node_modules",
    "coverage",
    "dist",
    "build",
    ".worktrees",
    "docs/goals",
    "test_resumes",
)


def verify_fixture(fixture: Path) -> None:
    fixture = fixture.resolve(strict=True)
    for relative in EXCLUDED_PATHS:
        try:
            os.lstat(fixture / relative)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise SystemExit("unable to verify packaged fixture exclusions") from error
        raise SystemExit("packaged fixture contains an excluded private or generated path")
    launcher = fixture / "scripts" / "qa-chrome.py"
    try:
        metadata = launcher.lstat()
    except OSError as error:
        raise SystemExit("packaged fixture is missing the replay QA launcher") from error
    if not os.path.isfile(launcher) or not stat.S_ISREG(metadata.st_mode):
        raise SystemExit("packaged replay QA launcher must be a regular file")
    for generated in fixture.rglob("*"):
        if generated.name == "__pycache__" or generated.suffix in {".pyc", ".pyo"}:
            raise SystemExit("packaged fixture contains generated Python content")
    print("Packaged fixture exclusions passed")


def prepare_prior(fixture: Path) -> None:
    fixture = fixture.resolve(strict=True)
    manifest_path = fixture / ".codex-plugin" / "plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["version"] = "1.1.0"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (fixture / "scripts" / "job-apply-store.py").write_text(
        "# isolated-old-version-sentinel\n", encoding="utf-8"
    )


def rewrite_marketplace(manifest_path: Path) -> None:
    manifest_path = manifest_path.resolve(strict=True)
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["plugins"][0]["source"] = "./"
    manifest_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)
    for action in ("verify", "prepare-prior", "rewrite-marketplace"):
        command = subparsers.add_parser(action)
        command.add_argument("path", type=Path)
    copy_parser = subparsers.add_parser("copy-critical")
    copy_parser.add_argument("source", type=Path)
    copy_parser.add_argument("target", type=Path)
    args = parser.parse_args()
    if args.action == "verify":
        verify_fixture(args.path)
    elif args.action == "prepare-prior":
        prepare_prior(args.path)
    elif args.action == "rewrite-marketplace":
        rewrite_marketplace(args.path)
    else:
        copy_critical(args.source, args.target)


if __name__ == "__main__":
    main()
