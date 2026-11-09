"""Observation delegates to actual OS/text writer; no flushing for snapshots."""
import hashlib
import json
import os
from pathlib import Path
import tempfile

def digest(data):
    return hashlib.sha256(data).hexdigest()

def points(value):
    return list(map(ord, value))

def error_record(error, seen=None):
    if error is None:
        return None
    seen = {} if seen is None else seen
    if id(error) in seen:
        return dict(ref=seen[id(error)])
    seen[id(error)] = len(seen)
    row = dict(name=type(error).__name__, message=str(error), errno=getattr(error, 'errno', None),
               cause=error_record(error.__cause__, seen), context=error_record(error.__context__, seen),
               suppressContext=error.__suppress_context__)
    if isinstance(error, UnicodeEncodeError):
        row.update(encoding=error.encoding, objectPoints=points(error.object), start=error.start,
                   end=error.end, reason=error.reason)
    return row

def file_state(path):
    st = path.lstat()
    return dict(kind='directory' if path.is_dir() else 'file', mode=st.st_mode & 0o777,
                ino=str(st.st_ino), device=str(st.st_dev), size=str(st.st_size),
                mtimeNs=str(st.st_mtime_ns), ctimeNs=str(st.st_ctime_ns),
                atimeNs=str(st.st_atime_ns),
                contentHex=path.read_bytes().hex() if path.is_file() else None)


def snapshot(root, temporary=None):
    return [dict(path='<temp>' if path == temporary else str(path.relative_to(root)),
                 **file_state(path)) for path in [root, *sorted(root.rglob('*'))]]

class Operations:
    name = os.name
    def __init__(self, target, faults):
        self.target, self.faults = target, faults
        self.events = []
        self.temporary_path = None
        self.original_temp = tempfile.NamedTemporaryFile
        owner = self
        class ObservedPath(type(Path())):
            def mkdir(self, *args, **kwargs):
                owner.events.append(dict(operation='mkdir', kwargs=kwargs))
                return super().mkdir(*args, **kwargs)
            def unlink(self, *args, **kwargs):
                owner.events.append(dict(operation='unlink', beforeHex=self.read_bytes().hex()))
                if 'unlink' in owner.faults:
                    raise OSError(5, 'synthetic unlink')
                return super().unlink(*args, **kwargs)
        self.Path = ObservedPath
    def __getattr__(self, name):
        return getattr(os, name)
    def chmod(self, path, mode):
        stage = 'parent-chmod' if path == self.target.parent else 'target-chmod' if path == self.target else 'temp-chmod'
        self.events.append(dict(operation=stage, mode=mode))
        if stage in self.faults:
            raise OSError(5, 'synthetic ' + stage)
        os.chmod(path, mode)
    def replace(self, source, target):
        self.events.append(dict(operation='replace'))
        os.replace(source, target)
    def open(self, path, flags, *args):
        self.events.append(dict(operation='open', flags=flags, mode=args[0] if args else None))
        return os.open(path, flags, *args)
    def fstat(self, fd):
        self.events.append(dict(operation='fstat'))
        return os.fstat(fd)
    def write(self, fd, data):
        row = dict(operation='os.write', hex=data.hex())
        self.events.append(row)
        result = os.write(fd, data)
        row['result'] = result
        return result
    def fsync(self, fd):
        self.events.append(dict(operation='fsync'))
        return os.fsync(fd)
    def close(self, fd):
        self.events.append(dict(operation='os.close'))
        return os.close(fd)
    def temporary(self, *args, **kwargs):
        self.events.append(dict(operation='temp-create', mode=kwargs.get('mode'), encoding=kwargs.get('encoding'), delete=kwargs.get('delete')))
        real = self.original_temp(*args, **kwargs)
        self.temporary_path = Path(real.name)
        owner = self
        class Writer:
            name = real.name
            def __enter__(self):
                real.__enter__()
                return self
            def write(self, value):
                row = dict(operation='temporary.write', points=points(value))
                owner.events.append(row)
                try:
                    result = real.write(value)
                    row['result'] = result
                    return result
                except BaseException as error:
                    row['error'] = error_record(error)
                    raise
                finally:
                    # Independent descriptor read; never flush/seek the writer.
                    row['visibleHexAfterCall'] = Path(real.name).read_bytes().hex()
            def flush(self):
                owner.events.append(dict(operation='temporary.flush'))
                return real.flush()
            def fileno(self):
                owner.events.append(dict(operation='temporary.fileno'))
                return real.fileno()
            def __exit__(self, *args):
                try:
                    return real.__exit__(*args)
                finally:
                    owner.events.append(dict(operation='temporary.close', postClose=file_state(Path(real.name))))
                    if 'close' in owner.faults:
                        raise OSError(5, 'synthetic close')
        return Writer()


class JsonObservation:
    """Keep actual dumps and strict str.encode; observe the intervening LF addition."""
    def __init__(self, events):
        self.events = events

    def dumps(self, value, **kwargs):
        self.events.append(dict(operation='json.dumps', kwargs=kwargs))
        text = json.dumps(value, **kwargs)
        events = self.events

        class ObservedText(str):
            def __add__(self, other):
                return ObservedText(str.__add__(self, other))

            def encode(self, *args, **kwargs):
                events.append(dict(operation='strictUtf8.encode', points=points(self),
                                   args=list(args), kwargs=kwargs))
                return str.encode(self, *args, **kwargs)

        return ObservedText(text)
