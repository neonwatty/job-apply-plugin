"""Owned binary stream boundary instrumentation and metadata witnesses."""
import builtins
import errno
import hashlib
import os
from pathlib import Path
import stat

STAMP = 1600000000000000000
DATA = b"synthetic-source\x00\xff\n"
OLD = b"old-target\x00\xfe"


def digest(data):
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "hex": data.hex() if len(data) <= 64 else None}


def snapshot(root):
    rows = []
    for path in [root, *sorted(root.rglob('*'))]:
        metadata = path.lstat()
        kind = ('link' if stat.S_ISLNK(metadata.st_mode) else 'directory' if stat.S_ISDIR(metadata.st_mode)
                else 'fifo' if stat.S_ISFIFO(metadata.st_mode) else 'file')
        # Stat precedes reads: atime is observed, but excluded from no-write claims.
        rows.append({"path": str(path.relative_to(root)), "kind": kind,
                     "mode": stat.S_IMODE(metadata.st_mode), "mtimeNs": str(metadata.st_mtime_ns),
                     "atimeNs": str(metadata.st_atime_ns), "ctimeNs": str(metadata.st_ctime_ns),
                     "content": digest(path.read_bytes()) if kind == 'file' else None,
                     "target": os.readlink(path) if kind == 'link' else None})
    return rows


def error_receipt(error, root):
    if error is None:
        return None
    return {"name": type(error).__name__, "message": str(error).replace(str(root), '<ROOT>'),
            "errno": getattr(error, 'errno', None), "stage": getattr(error, 'stage', None),
            "context": error_receipt(error.__context__, root) if error.__context__ is not None else None}


class InjectedFailure(OSError):
    def __init__(self, stage):
        super().__init__(errno.EIO, 'synthetic ' + stage)
        self.stage = stage


class Streams:
    def __init__(self, src, dst, case):
        self.src, self.dst, self.case = src, dst, case
        self.calls, self.handles = [], []
        self.reads = self.writes = 0

    def mark(self, stage, **arguments):
        self.calls.append({'stage': stage, **arguments})

    def open(self, path, mode):
        assert (path, mode) in [(self.src, 'rb'), (self.dst, 'wb')]
        owner = 'source' if mode == 'rb' else 'target'
        stage = owner + '-open'
        self.mark(stage, path=owner, mode=mode)
        if self.case == stage + '-error':
            raise InjectedFailure(stage)
        stream = builtins.open(path, mode)
        self.handles.append((owner, stream))
        outer = self

        class Observed:
            def __enter__(self):
                stream.__enter__()
                return self

            def __exit__(self, kind, value, traceback):
                stage = owner + '-close'
                outer.mark(stage)
                fail = outer.case == stage + '-error' or (
                    outer.case == 'read-both-close-error' or outer.case == 'write-target-close-error'
                    and owner == 'target')
                if fail:
                    raise InjectedFailure(stage)
                result = stream.__exit__(kind, value, traceback)
                if outer.case == stage + '-after-error':
                    raise InjectedFailure(stage + '-after')
                return result

            def fileno(self):
                return stream.fileno()

            def read(self, length):
                outer.reads += 1
                outer.mark('read', length=length)
                if outer.case in {'read-error', 'read-both-close-error'} or outer.case == 'partial-read-error' and outer.reads == 2:
                    raise InjectedFailure('read')
                data = stream.read(length)
                outer.mark('read-result', **digest(data))
                return data

            def write(self, data):
                outer.writes += 1
                outer.mark('write', **digest(data))
                if outer.case in {'write-error', 'write-target-close-error'} or outer.case == 'partial-write-error' and outer.writes == 2:
                    raise InjectedFailure('write')
                return stream.write(data[:3] if outer.case == 'short-write' else data)

            def flush(self):
                return stream.flush()

        return Observed()

    def witnesses(self):
        return [{'owner': owner, 'open': not stream.closed,
                 'size': os.fstat(stream.fileno()).st_size if not stream.closed else None}
                for owner, stream in self.handles]

    def cleanup(self):
        for _, stream in self.handles:
            stream.close()
