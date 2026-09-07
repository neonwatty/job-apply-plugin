"""Synthetic descriptor-digest reference with bounded, owned fault injection."""

import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from job_apply_store.constants import RESUME_MAX_BYTES
from job_apply_store.domains.resumes import storage

CASES = [
    "empty", "binary", "multichunk", "exact-max", "max-plus-one",
    "missing", "missing-parent", "directory", "symlink", "broken-link",
    "open-error", "fstat-error", "read-error", "close-error", "swap-symlink",
    "grow-after-stat",
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def snapshot(root):
    rows = []

    def visit(path, relative):
        metadata = path.lstat()
        kind = ("symlink" if stat.S_ISLNK(metadata.st_mode) else
                "directory" if stat.S_ISDIR(metadata.st_mode) else "file")
        rows.append({"path": relative, "kind": kind,
                     "mode": stat.S_IMODE(metadata.st_mode),
                     "mtimeNs": str(metadata.st_mtime_ns),
                     "sha256": digest(path.read_bytes()) if kind == "file" else None,
                     "target": os.readlink(path) if kind == "symlink" else None})
        if kind == "directory":
            for child in sorted(path.iterdir(), key=lambda value: value.name):
                visit(child, child.name if relative == "." else relative + "/" + child.name)

    visit(root, ".")
    return rows


class ObservedOS:
    """Forward real OS calls while recording value-free operation receipts."""

    def __init__(self, identifier, path, root):
        self.identifier = identifier
        self.path = path
        self.root = root
        self.events = []
        self.descriptors = []
        self.closed = []
        self.read_bytes = 0
        self.race_performed = False
        self.failure = None

    def __getattr__(self, name):
        return getattr(os, name)

    def open(self, path, flags):
        self.events.append({"op": "open", "flags": flags})
        if self.identifier == "open-error":
            raise OSError("synthetic open failure")
        if self.identifier == "swap-symlink":
            self.path.unlink()
            self.path.symlink_to("foreign.bin")
            self.race_performed = True
        try:
            descriptor = os.open(path, flags)
        except OSError as error:
            self.failure = error.errno
            raise
        self.descriptors.append(descriptor)
        return descriptor

    def fstat(self, descriptor):
        self.events.append({"op": "fstat"})
        if self.identifier == "fstat-error":
            raise OSError("synthetic fstat failure")
        metadata = os.fstat(descriptor)
        if self.identifier == "grow-after-stat":
            with self.path.open("ab") as destination:
                destination.write(b"x" * (RESUME_MAX_BYTES + 1))
            self.race_performed = True
        return metadata

    def read(self, descriptor, size):
        self.events.append({"op": "read", "requested": size})
        if self.identifier == "read-error":
            raise OSError("synthetic read failure")
        data = os.read(descriptor, size)
        self.read_bytes += len(data)
        return data

    def close(self, descriptor):
        self.events.append({"op": "close"})
        # Inject after actual close so even the close-error fixture owns no leak.
        os.close(descriptor)
        self.closed.append(descriptor)
        if self.identifier == "close-error":
            raise OSError("synthetic close failure")


def payload(identifier):
    sizes = {"empty": 0, "multichunk": 1024 * 1024 + 17,
             "exact-max": RESUME_MAX_BYTES, "max-plus-one": RESUME_MAX_BYTES + 1}
    if identifier in sizes:
        return b"x" * sizes[identifier]
    return b"synthetic\x00\xff\r\nbytes"


def run_case(identifier):
    native = identifier in ("symlink", "broken-link", "swap-symlink")
    if identifier == "swap-symlink" and not hasattr(os, "O_NOFOLLOW"):
        return {"id": identifier, "status": "unavailable", "native": True,
                "reason": "O_NOFOLLOW unavailable"}
    with tempfile.TemporaryDirectory(prefix="digest-reference-") as directory:
        root = Path(directory)
        path = root / "input.bin"
        data = payload(identifier)
        try:
            if identifier == "directory":
                path.mkdir()
            elif identifier == "missing-parent":
                path = root / "absent" / "input.bin"
            elif identifier in ("symlink", "broken-link"):
                if identifier == "symlink":
                    (root / "target.bin").write_bytes(data)
                path.symlink_to("target.bin")
            elif identifier != "missing":
                path.write_bytes(data)
            if identifier == "swap-symlink":
                (root / "foreign.bin").write_bytes(b"synthetic foreign bytes")
                probe = root / "probe"
                probe.symlink_to("foreign.bin")
                probe.unlink()
        except (OSError, NotImplementedError) as error:
            if not native:
                raise
            return {"id": identifier, "status": "unavailable", "native": True,
                    "reason": type(error).__name__}
        before = snapshot(root)
        observed = ObservedOS(identifier, path, root)
        previous = storage._RUNTIME_PROVIDER
        storage._bind_runtime(lambda: {"os": observed, "stat": stat,
                                      "hashlib": hashlib, "RESUME_MAX_BYTES": RESUME_MAX_BYTES})
        try:
            try:
                result = storage.ResumeStorageMixin._private_file_digest(path)
                outcome = {"kind": "return", "digest": result}
            except OSError as error:
                outcome = {"kind": "error", "name": type(error).__name__, "message": str(error)}
        finally:
            storage._bind_runtime(previous)
            # Detect and clean any unexpectedly surviving owned descriptor.
            leaked = []
            for descriptor in observed.descriptors:
                try:
                    os.fstat(descriptor)
                except OSError:
                    continue
                leaked.append(descriptor)
                os.close(descriptor)
        after = snapshot(root)
        return {
            "id": identifier, "status": "observed", "native": native,
            "inputSize": len(data) if identifier not in ("missing", "missing-parent", "directory", "broken-link") else None,
            "inputSha256": digest(data) if identifier not in ("missing", "missing-parent", "directory", "broken-link") else None,
            "outcome": outcome, "events": observed.events,
            "readBytes": observed.read_bytes, "openedCount": len(observed.descriptors),
            "closedCount": len(observed.closed), "leakedCount": len(leaked),
            "racePerformed": observed.race_performed, "openErrno": observed.failure,
            "before": before, "after": after, "unchanged": before == after,
        }


def main():
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("digest_reference_input_rejected\n")
        return 2
    result = {"schemaVersion": 1, "provenance": {
        "implementation": platform.python_implementation(), "python": platform.python_version(),
        "platform": sys.platform, "osName": os.name, "maximumBytes": RESUME_MAX_BYTES,
        "noFollow": getattr(os, "O_NOFOLLOW", None), "readOnly": os.O_RDONLY,
        "binary": getattr(os, "O_BINARY", 0),
        "sourceSha256": digest((ROOT / "scripts/job_apply_store/domains/resumes/storage.py").read_bytes()),
    }, "cases": [run_case(identifier) for identifier in CASES]}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("digest_reference_failed\n")
        raise SystemExit(2)
