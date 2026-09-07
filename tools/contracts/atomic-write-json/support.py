"""Real owned-file adapters for the atomic JSON reference; no Store objects."""
import errno
import hashlib
import os
from pathlib import Path
import stat
import tempfile


class InjectedFailure(OSError):
    def __init__(self, stage):
        super().__init__(errno.EIO, "synthetic " + stage)
        self.stage = stage


def outcome(error):
    if error is None:
        return {"kind": "value"}
    return {"kind": "error", "name": type(error).__name__,
            "errno": getattr(error, "errno", None),
            "stage": getattr(error, "stage", None),
            "context": None if error.__context__ is None else {
                "name": type(error.__context__).__name__,
                "stage": getattr(error.__context__, "stage", None)}}


def snapshot(root, temporary_path=None):
    rows = []

    def visit(path):
        metadata = path.lstat()
        kind = "symlink" if stat.S_ISLNK(metadata.st_mode) else "directory" if path.is_dir() else "file"
        relative = str(path.relative_to(root))
        if temporary_path is not None and path.resolve() == temporary_path.resolve():
            relative = str(path.parent.relative_to(root) / "<temp>")
        content = path.read_bytes() if kind == "file" else None
        rows.append({"path": relative, "kind": kind, "mode": stat.S_IMODE(metadata.st_mode),
                     "mtimeNs": str(metadata.st_mtime_ns),
                     "hex": content.hex() if content is not None else None,
                     "sha256": hashlib.sha256(content).hexdigest() if content is not None else None,
                     "target": os.readlink(path) if kind == "symlink" else None})
        if kind == "directory":
            for child in sorted(path.iterdir()):
                visit(child)

    visit(root)
    return sorted(rows, key=lambda row: row["path"])


class Operations:
    def __init__(self, root, target, faults):
        self.root = root
        self.target = target
        self.faults = set(faults)
        self.events = []
        self.calls = []
        self.temporary_path = None
        self.temporary_fd = None
        self.directory_fd = None
        self.temp_closed = None
        self.directory_closed = None
        self.write_calls = 0
        self.name = os.name
        self.original_temporary = tempfile.NamedTemporaryFile
        owner = self

        class ObservedPath(type(Path())):
            def mkdir(self, mode=0o777, parents=False, exist_ok=False):
                owner.event("mkdir", {"path": owner.path_label(self), "mode": mode,
                                      "parents": parents, "existOk": exist_ok})
                return super().mkdir(mode=mode, parents=parents, exist_ok=exist_ok)

            def unlink(self, *args, **kwargs):
                owner.event("cleanup", {"path": owner.path_label(self)})
                if "cleanup-missing" in owner.faults:
                    super().unlink(*args, **kwargs)
                    raise FileNotFoundError(errno.ENOENT, "synthetic already removed")
                return super().unlink(*args, **kwargs)

        self.Path = ObservedPath

    def path_label(self, path):
        path = Path(path)
        if self.temporary_path is not None and path == self.temporary_path:
            return str(path.parent.relative_to(self.root) / "<temp>")
        return str(path.relative_to(self.root))

    def event(self, stage, arguments=None):
        self.events.append(stage)
        self.calls.append({"stage": stage, "arguments": arguments or {}})
        if stage + "-value" in self.faults:
            raise ValueError("synthetic " + stage)
        if stage in self.faults:
            raise InjectedFailure(stage)

    def __getattr__(self, name):
        return getattr(os, name)

    def chmod(self, path, mode):
        stage = "parent-chmod" if path == self.target.parent else "temp-chmod" if path == self.temporary_path else "destination-chmod"
        self.event(stage, {"path": self.path_label(path), "mode": mode})
        os.chmod(path, mode)

    def replace(self, source, destination):
        self.event("replace", {"source": self.path_label(source), "destination": self.path_label(destination)})
        os.replace(source, destination)

    def open(self, path, flags):
        self.event("directory-open", {"path": self.path_label(path), "flags": flags})
        self.directory_fd = os.open(path, flags)
        self.directory_closed = False
        return self.directory_fd

    def fsync(self, descriptor):
        stage = "file-fsync" if descriptor == self.temporary_fd and not self.temp_closed else "directory-fsync"
        if stage == "directory-fsync" and descriptor != self.directory_fd:
            raise AssertionError("unexpected fsync descriptor")
        self.event(stage, {"descriptor": "temporary" if stage == "file-fsync" else "directory"})
        os.fsync(descriptor)

    def close(self, descriptor):
        if descriptor != self.directory_fd:
            raise AssertionError("unexpected directory close descriptor")
        # Close before the injected error: never leak a native descriptor in this harness.
        os.close(descriptor)
        self.directory_closed = True
        self.event("directory-close", {"descriptor": "directory"})

    def temporary(self, *args, **kwargs):
        self.event("temp-create", {"positionalCount": len(args),
                                  "kwargs": {key: self.path_label(value) if key == "dir" else value
                                             for key, value in kwargs.items()}})
        temporary = self.original_temporary(*args, **kwargs)
        self.temporary_path = Path(temporary.name)
        self.temporary_fd = temporary.fileno()
        self.temp_closed = False
        owner = self

        class ObservedTemporary:
            name = temporary.name

            def __enter__(self):
                temporary.__enter__()
                return self

            def __exit__(self, kind, error, traceback):
                try:
                    result = temporary.__exit__(kind, error, traceback)
                finally:
                    owner.temp_closed = temporary.file.closed
                owner.event("temp-close")
                return result

            def write(self, value):
                owner.write_calls += 1
                if owner.write_calls == 1:
                    if "partial-write" in owner.faults:
                        temporary.write(value[:1])
                    owner.event("partial-write" if "partial-write" in owner.faults else "write")
                return temporary.write(value)

            def flush(self):
                owner.event("flush")
                return temporary.flush()

            def fileno(self):
                return temporary.fileno()

        return ObservedTemporary()
