#!/usr/bin/env python3
"""Enforce the repository's monotonic source-size policy."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath


BASELINE_PATH = ".source-size-baseline.json"
MAXIMUM_LINES = 500
SOURCE_EXTENSIONS = {
    ".py", ".js", ".jsx", ".mjs", ".cjs",
    ".ts", ".tsx", ".mts", ".cts", ".swift", ".sh",
}
EXCLUDED_PARTS = {
    ".git", ".next", ".worktrees", "build", "coverage", "dist", "node_modules",
    "vendor",
}


def run_git(root, *args, text=True):
    return subprocess.run(
        ["git", *args], cwd=root, text=text, capture_output=True, check=False,
    )


def merge_base(root, ref):
    result = run_git(root, "merge-base", ref, "HEAD")
    return result.stdout.strip() if result.returncode == 0 else None


def git_file(root, revision, path):
    result = run_git(root, "show", f"{revision}:{path}")
    return result.stdout if result.returncode == 0 else None


def tracked_paths(root):
    result = run_git(
        root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", text=False,
    )
    if result.returncode:
        return []
    return sorted({os.fsdecode(path) for path in result.stdout.split(b"\0") if path})


def is_excluded(path):
    return bool(set(PurePosixPath(path).parts) & EXCLUDED_PARTS)


def is_source(path):
    return not is_excluded(path) and PurePosixPath(path).suffix in SOURCE_EXTENSIONS


def physical_lines(path):
    contents = path.read_bytes()
    if not contents:
        return 0
    return contents.count(b"\n") + (not contents.endswith(b"\n"))


def load_baseline(text):
    if text is None:
        return None, []
    try:
        data = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return None, ["baseline: invalid JSON"]
    if not isinstance(data, dict):
        return None, ["baseline: expected an object"]
    errors = []
    if data.get("version") != 1:
        errors.append("baseline: version must be 1")
    if data.get("maximumLines") != MAXIMUM_LINES:
        errors.append("baseline: maximumLines must be 500")
    files = data.get("files")
    if not isinstance(files, dict):
        return None, errors + ["baseline: files must be an object"]
    for path, entry in files.items():
        if not isinstance(path, str) or not valid_path(path):
            errors.append("baseline: file path is invalid")
            continue
        if is_excluded(path):
            errors.append(f"{path}: excluded source path")
        elif PurePosixPath(path).suffix not in SOURCE_EXTENSIONS:
            errors.append(f"{path}: unsupported source extension")
        if not isinstance(entry, dict):
            errors.append(f"{path}: baseline entry must be an object")
            continue
        if set(entry) != {"ceiling", "owner", "reason", "removalPhase"}:
            errors.append(f"{path}: baseline entry has invalid fields")
            continue
        if type(entry["ceiling"]) is not int or entry["ceiling"] <= MAXIMUM_LINES:
            errors.append(f"{path}: ceiling must be an integer above 500")
        for field in ("owner", "reason", "removalPhase"):
            if not isinstance(entry[field], str) or not entry[field].strip():
                errors.append(f"{path}: {field} must be a non-empty string")
    return data, errors


def valid_path(path):
    candidate = PurePosixPath(path)
    return not candidate.is_absolute() and ".." not in candidate.parts and str(candidate) == path


def current_baseline(root):
    path = root / BASELINE_PATH
    if not path.exists():
        return load_baseline(None)
    try:
        return load_baseline(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        return None, ["baseline: invalid UTF-8"]


def source_lines(root):
    return {
        path: physical_lines(root / path)
        for path in tracked_paths(root)
        if is_source(path) and (root / path).is_file()
    }


def check(root, base_ref):
    base = merge_base(root, base_ref)
    if base is None:
        return ["baseline: unable to resolve merge base"]
    baseline, errors = current_baseline(root)
    if errors:
        return sorted(errors)
    current_files = {} if baseline is None else baseline["files"]
    base_baseline, base_errors = load_baseline(git_file(root, base, BASELINE_PATH))
    if base_errors:
        return sorted(f"base {error}" for error in base_errors)
    base_files = {} if base_baseline is None else base_baseline["files"]
    lines = source_lines(root)

    for path in sorted(current_files):
        if path not in base_files and base_baseline is not None:
            errors.append(f"{path}: new baseline entry")
        if path not in base_files and base_baseline is None:
            if git_file(root, base, path) is None:
                errors.append(f"{path}: baseline entries must exist in the base revision")
        if path in base_files and current_files[path]["ceiling"] > base_files[path]["ceiling"]:
            errors.append(
                f"{path}: ceiling increased from {base_files[path]['ceiling']} "
                f"to {current_files[path]['ceiling']}"
            )

    for path in sorted(base_files):
        if path not in current_files and lines.get(path, 0) > MAXIMUM_LINES:
            errors.append(f"{path}: baseline entry removed while file remains oversized")

    for path, count in sorted(lines.items()):
        entry = current_files.get(path)
        if count > MAXIMUM_LINES and entry is None:
            errors.append(f"{path}: {count} > {MAXIMUM_LINES}")
        if entry is None:
            continue
        ceiling = entry["ceiling"]
        if count <= MAXIMUM_LINES:
            errors.append(f"{path}: {count} <= {MAXIMUM_LINES} must be removed from baseline")
        elif count > ceiling:
            errors.append(f"{path}: {count} > ceiling {ceiling}")
        elif count < ceiling:
            errors.append(f"{path}: {count} < recorded ceiling {ceiling}; reduce ceiling")

    for path in sorted(current_files):
        if path not in lines:
            errors.append(f"{path}: obsolete baseline entry")
    return sorted(set(errors))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="origin/staging")
    args = parser.parse_args()
    errors = check(Path.cwd(), args.base)
    if errors:
        for error in errors:
            print(f"source-size: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
