"""Owned native descriptor observations with explicit synthetic failure points."""
import errno
import hashlib
import os
from pathlib import Path
import stat


class InjectedFailure(OSError):
    def __init__(self, stage):
        super().__init__(errno.EIO, "synthetic " + stage)
        self.stage = stage


def outcome(error):
    if error is None:
        return {"kind": "value"}
    return {"kind": "error", "name": type(error).__name__,
            "errno": getattr(error, "errno", None), "stage": getattr(error, "stage", None),
            "message": str(error) if type(error).__name__ == "StoreError" else None,
            "context": None if error.__context__ is None else outcome(error.__context__)}


def snapshot(root):
    result = []
    for path in [root, *sorted(root.iterdir())]:
        info = path.lstat()
        kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file"
        data = path.read_bytes() if kind == "file" else None
        result.append({"path": "." if path == root else path.name, "kind": kind,
                       "mode": stat.S_IMODE(info.st_mode), "mtimeNs": str(info.st_mtime_ns),
                       "hex": data.hex() if data is not None else None,
                       "sha256": hashlib.sha256(data).hexdigest() if data is not None else None,
                       "target": os.readlink(path) if kind == "symlink" else None})
    return result


class Operations:
    def __init__(self, path, faults, behavior, operation):
        self.path = path
        self.faults = faults
        self.behavior = behavior
        self.calls = []
        self.descriptors = set()
        self.write_count = 0
        self.sync_count = 0
        self.name = os.name
        self.operation = operation
        self.rolling_back = False

    def __getattr__(self, key):
        return getattr(os, key)

    def event(self, stage, arguments=None):
        self.calls.append({"stage": stage, "arguments": arguments or {}})
        if stage in self.faults:
            raise InjectedFailure(stage)

    def open(self, path, flags, mode=None):
        assert path == self.path
        self.event("open", {"flags": flags, "mode": mode})
        descriptor = os.open(path, flags) if mode is None else os.open(path, flags, mode)
        self.descriptors.add(descriptor)
        return descriptor

    def fstat(self, descriptor):
        assert descriptor in self.descriptors
        self.event("fstat")
        return os.fstat(descriptor)

    def write(self, descriptor, data):
        assert descriptor in self.descriptors
        self.write_count += 1
        self.event("write", {"hex": data.hex()})
        if self.behavior == "baseexception":
            raise KeyboardInterrupt("synthetic write")
        if self.behavior == "zero" or self.behavior == "partial-zero" and self.write_count == 2:
            return 0
        if self.behavior == "negative":
            return -1
        if self.behavior == "partial-error" and self.write_count == 2:
            raise InjectedFailure("write")
        if self.behavior in {"short", "partial-error", "partial-zero"}:
            data = data[:5]
        return os.write(descriptor, data)

    def read(self, descriptor, length):
        assert descriptor in self.descriptors
        self.event("read", {"length": length})
        return os.read(descriptor, 5 if self.behavior == "short-read" else length)

    def fsync(self, descriptor):
        assert descriptor in self.descriptors
        self.sync_count += 1
        self.event("rollback-fsync" if self.rolling_back else "fsync")
        os.fsync(descriptor)

    def ftruncate(self, descriptor, size):
        assert descriptor in self.descriptors
        self.rolling_back = self.operation == "append"
        self.event("truncate", {"size": size})
        os.ftruncate(descriptor, size)

    def close(self, descriptor):
        assert descriptor in self.descriptors
        self.event("close")
        os.close(descriptor)
        self.descriptors.remove(descriptor)

    def chmod(self, path, mode):
        assert path == self.path
        self.event("chmod", {"mode": mode})
        os.chmod(path, mode)

    def cleanup(self):
        for descriptor in self.descriptors:
            os.close(descriptor)
        self.descriptors.clear()
