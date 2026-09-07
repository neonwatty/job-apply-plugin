"""Read-only delegates around original pathlib and descriptor operations."""
import hashlib
import os
from pathlib import Path
import stat
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from fixtures import FILE_BYTES, cache_keys, record, record_points, typed


def points(value):
    return list(map(ord, value))


def digest(value):
    return hashlib.sha256(value).hexdigest()


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
    if isinstance(error, UnicodeError):
        row.update(encoding=error.encoding, objectPoints=points(error.object) if isinstance(error.object, str) else None,
                   objectHex=error.object.hex() if isinstance(error.object, bytes) else None,
                   start=error.start, end=error.end, reason=error.reason)
    return row


def snapshot(root):
    result = []
    for path in [root, *sorted(root.rglob('*'))]:
        metadata = path.lstat()
        kind = 'symlink' if path.is_symlink() else 'directory' if path.is_dir() else 'file'
        result.append(dict(path=str(path.relative_to(root)), kind=kind, mode=metadata.st_mode & 0o777,
                           ino=str(metadata.st_ino), device=str(metadata.st_dev), size=str(metadata.st_size),
                           mtimeNs=str(metadata.st_mtime_ns), ctimeNs=str(metadata.st_ctime_ns),
                           atimeNs=str(metadata.st_atime_ns),
                           contentHex=path.read_bytes().hex() if kind == 'file' else None,
                           target=os.readlink(path) if kind == 'symlink' else None))
    return result


def setup(root, name=None):
    files = root / 'files'
    files.mkdir(parents=True, mode=0o700)
    if name in ('outside-parent', 'pair-outside-link'):
        (root / 'outside').mkdir(mode=0o700)
    if name == 'pair-inside-link':
        (files / 'inside').symlink_to('.')
    if name == 'pair-outside-link':
        (files / 'outside-link').symlink_to('../outside')
    sentinel = root / 'sentinel'
    sentinel.write_bytes(b'sentinel')
    sentinel.chmod(0o600)
    return files


def parent_case(name, root, storage):
    files = setup(root, name)
    events, resolve_calls = [], 0
    original = record(name)

    class Record(dict):
        def __getitem__(self, key):
            events.append(dict(operation='record[' + key + ']'))
            return super().__getitem__(key)

    class Resolved:
        def __init__(self, value):
            self.value = value
        def __ne__(self, other):
            different = self.value != other.value
            events.append(dict(operation='resolved parent == resolved root', equal=not different))
            return different

    class ObservedPath:
        def __init__(self, value, label):
            self.value, self.label = value, label
        def __truediv__(self, child):
            events.append(dict(operation='root / managedFile', child=typed(child)))
            return ObservedPath(self.value / child, 'candidate')
        @property
        def parent(self):
            return ObservedPath(self.value.parent, 'candidate.parent')
        def resolve(self, *, strict):
            nonlocal resolve_calls
            resolve_calls += 1
            events.append(dict(operation=self.label + '.resolve(strict=false)', strict=strict,
                               pathPoints=points(str(self.value))))
            if resolve_calls == (1 if name == 'pair-parent-error' else 2 if name == 'pair-root-error' else -1):
                raise OSError(5, 'synthetic resolve')
            return Resolved(self.value.resolve(strict=strict))

    event = Record(original)
    original_identity = id(event)
    before = snapshot(root)
    result, caught = None, None
    try:
        path = storage.ResumeStorageMixin._managed_resume_path(
            SimpleNamespace(resume_files_path=ObservedPath(files, 'root')), event)
        encoded, encoding_error = None, None
        try:
            encoded = os.fsencode(path.value).hex()
        except UnicodeError as error:
            encoding_error = error_record(error)
        result = dict(pathPoints=points(str(path.value)), outputHex=encoded, error=encoding_error)
    except BaseException as error:
        caught = error_record(error)
    return dict(id='managed-' + name, record=record_points(original), recordAfter=record_points(event),
                sameRecordObject=id(event) == original_identity, rootPoints=points(str(files)),
                resolvedRootPoints=points(str(files.resolve())), events=events, error=caught,
                result=result, before=before, after=snapshot(root))


def cache_case(name, root, storage, normalization, constants):
    files = setup(root)
    path = files / 'file.bin'
    path.write_bytes(FILE_BYTES)
    path.chmod(0o600)
    # Fixed fixture mtime avoids unrelated Python/JS fractional-second rounding.
    os.utime(path, ns=(path.stat().st_atime_ns, 1_700_000_000_000_000_000))
    keys = cache_keys(name)
    now = datetime(2026, 1, 2, tzinfo=timezone.utc)
    t0 = now
    events, calls = [], []
    digest_active = False
    stat_calls = 0
    metadata = path.lstat()
    identity = normalization._managed_resume_digest_cache_identity(metadata)

    def stat_record(value):
        return dict(mode=value.st_mode, size=str(value.st_size), identity=[str(part) for part in (
            value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)])

    class ObservedPath:
        def __init__(self, value, label='root'):
            self.value, self.label = value, label
        def __fspath__(self):
            return str(self.value)
        def __truediv__(self, child):
            return ObservedPath(self.value / child, 'candidate')
        @property
        def parent(self):
            return ObservedPath(self.value.parent, 'parent')
        def resolve(self, *, strict):
            events.append('managed_path:' + self.label + '.resolve')
            return self.value.resolve(strict=strict)
        def lstat(self):
            nonlocal stat_calls
            stat_calls += 1
            events.append('path.lstat:' + ('first' if stat_calls == 1 else 'second'))
            value = self.value.lstat()
            metadata_reads.append(stat_record(value))
            return value
        def is_symlink(self):
            events.append('private_digest:path.is_symlink' if digest_active else 'path.is_symlink')
            return self.value.is_symlink()

    class Record(dict):
        def __getitem__(self, key):
            if key == 'id':
                events.append('record[id]')
            return super().__getitem__(key)

    class Cache(dict):
        def get(self, key, default=None):
            events.append('cache.get(key)')
            return super().get(key, default)
        def __setitem__(self, key, value):
            events.append('cache[key] = entry')
            return super().__setitem__(key, value)

    class OS:
        def __getattr__(self, name):
            return getattr(os, name)
        def open(self, target, flags):
            events.append('private_digest:os.open(O_RDONLY|O_NOFOLLOW)')
            descriptor_calls.append(dict(operation='open', pathPoints=points(os.fspath(target)), flags=flags))
            return os.open(target, flags)
        def fstat(self, descriptor):
            events.append('private_digest:os.fstat')
            value = os.fstat(descriptor)
            descriptor_calls.append(dict(operation='fstat', metadata=stat_record(value)))
            return value
        def read(self, descriptor, count):
            value = os.read(descriptor, count)
            reads.append(dict(requested=count, hex=value.hex()))
            events.append('private_digest:os.read')
            return value
        def close(self, descriptor):
            events.append('private_digest:os.close')
            return os.close(descriptor)

    class Hash:
        def __init__(self):
            self.value = hashlib.sha256()
        def update(self, value):
            self.value.update(value)
        def hexdigest(self):
            events.append('private_digest:sha256.hexdigest')
            return self.value.hexdigest()

    def regular(mode):
        events.append('private_digest:S_ISREG' if digest_active else 'S_ISREG(' + ('first' if stat_calls == 1 else 'second') + ')')
        return stat.S_ISREG(mode)
    def cache_identity(value):
        events.append('cache_identity(' + ('first' if stat_calls == 1 else 'second') + ')')
        return normalization._managed_resume_digest_cache_identity(value)
    def modified(value):
        events.append('modified_at(' + ('first' if stat_calls == 1 else 'second') + ')')
        return normalization._resume_modified_at(value)
    def clock():
        events.append('clock.now')
        return now
    def private_digest(value):
        nonlocal digest_active
        digest_active = True
        try:
            return storage.ResumeStorageMixin._private_file_digest(value)
        finally:
            digest_active = False

    instance = SimpleNamespace(resume_files_path=ObservedPath(files), _now_datetime=clock,
                               _private_file_digest=private_digest)
    instance._managed_resume_path = lambda record: storage.ResumeStorageMixin._managed_resume_path(instance, record)
    previous = storage._RUNTIME_PROVIDER
    storage._bind_runtime(lambda: dict(os=OS(), stat=SimpleNamespace(S_ISREG=regular),
        hashlib=SimpleNamespace(sha256=Hash), timedelta=timedelta,
        RESUME_MAX_BYTES=constants.RESUME_MAX_BYTES, OVERVIEW_DIGEST_CACHE_SECONDS=constants.OVERVIEW_DIGEST_CACHE_SECONDS,
        _resume_modified_at=modified, _managed_resume_digest_cache_identity=cache_identity))
    cache = Cache()

    def entries():
        return [dict(key=typed(key), originalKeyCall=next(i for i, original in enumerate(keys) if original is key),
                     checkedAtSeconds=int((value['checkedAt'] - t0).total_seconds()),
                     identity=[str(part) for part in value['identity']], digest=value['digest'])
                for key, value in cache.items()]

    before = snapshot(root)
    try:
        for index, key in enumerate(keys):
            events, reads, stat_calls = [], [], 0
            metadata_reads, descriptor_calls = [], []
            offset = constants.OVERVIEW_DIGEST_CACHE_SECONDS if name == 'expired-pair' and index else 0
            now = t0 + timedelta(seconds=offset)
            cache_before = entries()
            event = Record(storageKind='managed', managedFile='file.bin', id=key)
            result = storage.ResumeStorageMixin._managed_resume_observation(instance, event, digest_cache=cache)
            calls.append(dict(key=typed(key), recordAfter=record_points(event), clockOffsetSeconds=offset,
                              events=events, reads=reads, metadataReads=metadata_reads, descriptorCalls=descriptor_calls,
                              result=result, cacheBefore=cache_before,
                              cacheAfter=entries(), retainedKeyObjectFromCall=next(i for i, original in enumerate(keys)
                                  if next(stored for stored in cache if stored == key) is original)))
    finally:
        storage._bind_runtime(previous)
    return dict(id='cache-' + name, calls=calls, keyIdentity=[[a is b for b in keys] for a in keys],
                ttlSeconds=constants.OVERVIEW_DIGEST_CACHE_SECONDS, identity=[str(part) for part in identity],
                mtimeFloat=metadata.st_mtime, before=before, after=snapshot(root))
