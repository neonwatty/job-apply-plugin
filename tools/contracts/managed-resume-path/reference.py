"""Fixed path-resolution observations; no Store instance or caller-owned path."""

import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from job_apply_store.domains.resumes.storage import ResumeStorageMixin

LINK_CASES = {"inside-link", "outside-link", "loop-parent", "loop-leaf", "leaf-link",
              "chain-inside", "chain-outside", "multi-loop", "missing-link",
              "link-nested-dotdot", "absolute-link", "root-link", "root-link-absolute"}
FAULT_CASES = {"parent-resolve-oserror": 1, "root-resolve-oserror": 2}


def snapshot(root):
    result = []

    def visit(path, relative):
        metadata = path.lstat()
        kind = "symlink" if stat.S_ISLNK(metadata.st_mode) else "directory" if path.is_dir() else "file"
        result.append({
            "path": relative,
            "kind": kind,
            "mode": stat.S_IMODE(metadata.st_mode),
            "mtimeNs": str(metadata.st_mtime_ns),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if kind == "file" else None,
            "target": os.readlink(path).replace(str(root), "<root>", 1) if kind == "symlink" else None,
        })
        if kind == "directory":
            for child in sorted(path.iterdir()):
                visit(child, str(child.relative_to(root)))

    visit(root, ".")
    return result


def capture():
    with tempfile.TemporaryDirectory(prefix="managed-resume-path-") as temporary:
        root = Path(temporary)
        managed = root / "managed"
        managed.mkdir()
        (managed / "nested").mkdir()
        (root / "outside").mkdir()
        (managed / "file.bin").write_bytes(b"synthetic managed bytes")
        link_status = "available"
        try:
            (managed / "inside").symlink_to(".", target_is_directory=True)
            (managed / "outside-link").symlink_to("../outside", target_is_directory=True)
            (managed / "loop").symlink_to("loop", target_is_directory=True)
            (managed / "leaf-link").symlink_to("../outside/missing.bin")
            (managed / "chain").symlink_to("inside", target_is_directory=True)
            (managed / "chain-outside").symlink_to("outside-link", target_is_directory=True)
            (managed / "loop-a").symlink_to("loop-b", target_is_directory=True)
            (managed / "loop-b").symlink_to("loop-a", target_is_directory=True)
            (managed / "missing-link").symlink_to("absent", target_is_directory=True)
            (managed / "nested-link").symlink_to("nested", target_is_directory=True)
            (managed / "absolute-link").symlink_to(managed, target_is_directory=True)
            (root / "managed-alias").symlink_to("managed", target_is_directory=True)
        except (OSError, NotImplementedError) as error:
            link_status = type(error).__name__
        records = [
            ("missing-storage", {}),
            ("external", {"storageKind": "external"}),
            ("missing-name", {"storageKind": "managed"}),
        ]
        paths = [
            ("normal", "file.bin"), ("dot", "./file.bin"),
            ("empty", ""), ("dot-only", "."), ("parent", "../file.bin"),
            ("nested", "nested/file.bin"), ("nested-dotdot", "nested/../file.bin"),
            ("missing-tail", "missing.bin"), ("missing-parent", "absent/file.bin"),
            ("missing-dotdot", "absent/../file.bin"),
            ("absolute-inside", str(managed / "file.bin")),
            ("absolute-outside", str(root / "outside/file.bin")),
            ("null-name", None), ("integer-name", 1),
            ("inside-link", "inside/file.bin"), ("outside-link", "outside-link/file.bin"),
            ("loop-parent", "loop/file.bin"), ("loop-leaf", "loop"),
            ("leaf-link", "leaf-link"),
            ("repeated-separators", "nested//../file.bin"),
            ("trailing-separator", "file.bin/"),
            ("embedded-dot", "nested/./../file.bin"),
            ("multiple-missing", "absent/tail/../../file.bin"),
            ("non-directory-parent", "file.bin/tail"),
            ("non-directory-dotdot", "file.bin/../file.bin"),
            ("chain-inside", "chain/file.bin"),
            ("chain-outside", "chain-outside/file.bin"),
            ("multi-loop", "loop-a/file.bin"),
            ("missing-link", "missing-link/file.bin"),
            ("link-nested-dotdot", "nested-link/../file.bin"),
            ("absolute-link", "absolute-link/file.bin"),
            ("root-link", "file.bin"),
            ("root-link-absolute", str(managed / "file.bin")),
            ("parent-resolve-oserror", "file.bin"),
            ("root-resolve-oserror", "file.bin"),
        ]
        records.extend((name, {"storageKind": "managed", "managedFile": value}) for name, value in paths)
        results = []
        for identifier, record in records:
            if identifier in LINK_CASES and link_status != "available":
                results.append({"id": identifier, "status": "unavailable", "reason": link_status})
                continue
            before = snapshot(root)
            calls = []
            base = root / "managed-alias" if identifier.startswith("root-link") else managed
            instance = SimpleNamespace(resume_files_path=base)
            original_resolve = Path.resolve

            def resolve_with_fault(path, strict=False):
                calls.append({"call": len(calls) + 1, "strict": strict})
                if len(calls) == FAULT_CASES[identifier]:
                    raise OSError("synthetic resolution failure")
                return original_resolve(path, strict=strict)

            try:
                if identifier in FAULT_CASES:
                    with patch.object(Path, "resolve", resolve_with_fault):
                        candidate = ResumeStorageMixin._managed_resume_path(instance, record)
                else:
                    candidate = ResumeStorageMixin._managed_resume_path(instance, record)
                # Root substitution preserves candidate lexical components and
                # removes only the harness-owned temporary prefix.
                outcome = {"kind": "path", "path": str(candidate).replace(str(root), "<root>", 1)}
            except Exception as error:
                outcome = {"kind": "error", "name": type(error).__name__}
                if type(error).__name__ == "StoreError":
                    outcome["message"] = str(error)
            after = snapshot(root)
            results.append({"id": identifier, "status": "observed", "outcome": outcome,
                            "native": identifier not in FAULT_CASES, "resolveCalls": calls,
                            "before": before, "after": after, "unchanged": before == after})
        source = ROOT / "scripts/job_apply_store/domains/resumes/storage.py"
        return {"schemaVersion": 1, "provenance": {
            "implementation": platform.python_implementation(),
            "python": platform.python_version(), "platform": sys.platform,
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "symlinks": link_status,
        }, "cases": results}


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("managed_path_reference_input_rejected\n")
        sys.exit(2)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
