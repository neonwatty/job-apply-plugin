"""Owned POSIX byte-path observations; no caller inputs or live Store."""

import hashlib
import errno
import json
import os
from pathlib import Path
import platform
import stat
import sys
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from job_apply_store.domains.resumes.storage import ResumeStorageMixin


def snapshot(root):
    rows = []

    def visit(path, relative):
        info = os.lstat(path)
        kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file"
        payload = None
        if kind == "file":
            with open(path, "rb") as source:
                payload = hashlib.sha256(source.read()).hexdigest()
        rows.append({"pathHex": relative.hex(), "kind": kind,
                     "mode": stat.S_IMODE(info.st_mode), "mtimeNs": str(info.st_mtime_ns),
                     "sha256": payload,
                     "targetHex": os.readlink(path).hex() if kind == "symlink" else None})
        if kind == "directory":
            for name in sorted(os.listdir(path)):
                visit(path + b"/" + name, name if relative == b"." else relative + b"/" + name)

    visit(root, b".")
    return rows


def capture():
    provenance = {"implementation": platform.python_implementation(),
                  "python": platform.python_version(), "platform": sys.platform,
                  "filesystemEncoding": sys.getfilesystemencoding(),
                  "filesystemErrors": sys.getfilesystemencodeerrors(),
                  "sourceSha256": hashlib.sha256((ROOT / "scripts/job_apply_store/domains/resumes/storage.py").read_bytes()).hexdigest()}
    if os.name != "posix":
        return {"schemaVersion": 1, "provenance": provenance,
                "status": "unavailable", "reason": "POSIX byte paths required", "cases": []}
    with tempfile.TemporaryDirectory(prefix="posix-byte-reference-") as temporary:
        temporary = str(Path(temporary).resolve())
        root = os.fsencode(temporary)
        managed = root + b"/managed"
        os.mkdir(managed)
        names_available = True
        setup_failure = None
        stage = "mkdir-byte-name"
        try:
            os.mkdir(managed + b"/\xff")
            stage = "write-byte-name"
            with open(managed + b"/\xff/data", "wb") as target:
                target.write(b"synthetic")
            stage = "symlink-byte-name"
            os.symlink(b".", managed + b"/\xfe")
        except OSError as error:
            if error.errno != errno.EILSEQ:
                raise
            names_available = False
            setup_failure = {"stage": stage, "name": type(error).__name__, "errno": error.errno}
        os.symlink(b"\xff", managed + b"/byte-target")
        os.symlink(b"\xfd", managed + b"/dangling-byte")
        os.mkdir(managed + "/😀".encode())
        cases = [
            ("resolve-byte-directory", "resolve", os.fsdecode(b"\xff")),
            ("resolve-byte-file", "resolve", os.fsdecode(b"\xff/data")),
            ("resolve-byte-link", "resolve", os.fsdecode(b"\xfe")),
            ("resolve-byte-target", "resolve", "byte-target"),
            ("resolve-dangling-byte", "resolve", "dangling-byte"),
            ("resolve-astral", "resolve", "😀"),
            ("managed-byte-leaf", "managed", os.fsdecode(b"\xff")),
            ("managed-byte-parent", "managed", os.fsdecode(b"\xff/data")),
            ("managed-byte-link-parent", "managed", os.fsdecode(b"\xfe/data")),
            ("managed-dangling-byte-parent", "managed", "dangling-byte/data"),
            ("managed-nul-leaf", "managed", "nul\0"),
            ("managed-nul-parent", "managed", "nul\0/data"),
            ("resolve-high-surrogate", "resolve", "\ud800"),
            ("resolve-low-nonescape-surrogate", "resolve", "\udc7f"),
            ("resolve-escape-surrogate", "resolve", "\udc80"),
            ("managed-high-surrogate-leaf", "managed", "\ud800"),
        ]
        observations = []
        for identifier, operation, relative in cases:
            if not names_available and identifier in (
                "resolve-byte-directory", "resolve-byte-file", "resolve-byte-link",
                "managed-byte-parent", "managed-byte-link-parent",
            ):
                observations.append({"id": identifier, "status": "unavailable",
                                     "reason": "Filesystem rejects native non-UTF-8 names",
                                     "setupFailure": setup_failure})
                continue
            before = snapshot(root)
            try:
                if operation == "resolve":
                    result = (Path(os.fsdecode(managed)) / relative).resolve(strict=False)
                else:
                    result = ResumeStorageMixin._managed_resume_path(
                        SimpleNamespace(resume_files_path=Path(os.fsdecode(managed))),
                        {"storageKind": "managed", "managedFile": relative})
                rendered = str(result).replace(temporary, "<root>", 1)
                try:
                    encoded = os.fsencode(rendered).hex()
                except UnicodeEncodeError:
                    encoded = None
                outcome = {"kind": "path", "path": rendered, "pathHex": encoded}
            except Exception as error:
                outcome = {"kind": "error", "name": type(error).__name__}
                if type(error).__name__ == "StoreError":
                    outcome["message"] = str(error)
            after = snapshot(root)
            observations.append({"id": identifier, "status": "observed", "operation": operation,
                                 "input": relative, "outcome": outcome,
                                 "before": before, "after": after, "unchanged": before == after})
        return {"schemaVersion": 1, "provenance": provenance,
                "status": "observed", "reason": None, "cases": observations}


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("posix_bytes_reference_input_rejected\n")
        sys.exit(2)
    try:
        print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
    except Exception:
        sys.stderr.write("posix_bytes_reference_failed\n")
        sys.exit(2)
