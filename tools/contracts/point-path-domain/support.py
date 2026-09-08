"""Owned native fixtures and transparent delegates around unchanged Python methods."""
import hashlib
import json
import os
import stat
from pathlib import Path
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from fixtures import FILE_BYTES, values


def digest(value):
    return hashlib.sha256(value).hexdigest()


class Pool:
    """Lossless interned observations: references expand to complete exact JSON values."""
    def __init__(self):
        self.rows, self.keys = [], {}
    def add(self, value):
        key = json.dumps(value, sort_keys=True, separators=(',', ':'))
        if key not in self.keys:
            self.keys[key] = len(self.rows)
            self.rows.append(value)
        return self.keys[key]


def error_record(error):
    if error is None:
        return None
    return dict(name=type(error).__name__, message=str(error), errno=getattr(error, 'errno', None),
                cause=error_record(error.__cause__), context=error_record(error.__context__),
                suppressContext=error.__suppress_context__)


def typed(value):
    if value is None:
        return dict(type='none')
    if isinstance(value, bool):
        return dict(type='bool', value=value)
    if isinstance(value, int):
        return dict(type='int', decimal=str(value))
    if isinstance(value, float):
        return dict(type='float', hex=value.hex())
    if isinstance(value, str):
        return dict(type='text', points=list(map(ord, value)))
    return dict(type='list' if isinstance(value, list) else 'dict', length=len(value))


def snapshot(root, pool):
    result = []
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        result.append(pool.add(dict(path=str(path.relative_to(root)), mode=info.st_mode,
                           device=str(info.st_dev), ino=str(info.st_ino), size=str(info.st_size),
                           mtimeNs=str(info.st_mtime_ns), ctimeNs=str(info.st_ctime_ns),
                           atimeNs=str(info.st_atime_ns),
                           sha256=digest(path.read_bytes()) if path.is_file() else None)))
    return pool.add(result)


def observe(recipe, root, storage, normalization, constants, pool):
    root.mkdir(mode=0o700)
    files = root / 'files'
    files.mkdir(mode=0o700)
    sentinel = root / 'sentinel'
    sentinel.write_bytes(b'sentinel')
    sentinel.chmod(0o600)
    if recipe['kind'] != 'file':
        path = files / 'file.bin'
        path.write_bytes(FILE_BYTES)
        path.chmod(0o600)
        os.utime(path, ns=(path.stat().st_atime_ns, 1700000000000000000))
    nodes = values()
    refs = recipe.get('refs', [])
    node_refs = set(refs + ([recipe['file_ref']] if 'file_ref' in recipe else []))
    nodes_used = {ref: typed(nodes[ref]) for ref in sorted(node_refs)}
    events, stat_calls, digest_active = [], 0, False
    now = datetime(2026, 1, 2, tzinfo=timezone.utc)

    def event(name, *args):
        events.append(pool.add([name, *args]))
    def path_value(path):
        return str(path.relative_to(root))
    def metadata(value):
        return pool.add(dict(mode=value.st_mode, identity=[str(part) for part in (
            value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)],
            mtimeSeconds=value.st_mtime))

    class Record(dict):
        def get(self, key, default=None):
            event('record.get', key)
            return super().get(key, default)
        def __getitem__(self, key):
            event('record[]', key)
            return super().__getitem__(key)

    class ObservedPath:
        def __init__(self, value, label='root'):
            self.value, self.label = value, label
        def __fspath__(self):
            return str(self.value)
        def __truediv__(self, child):
            event('path.join', typed(child))
            return ObservedPath(self.value / child, 'candidate')
        @property
        def parent(self):
            event('path.parent')
            return ObservedPath(self.value.parent, 'parent')
        def resolve(self, *, strict):
            event('path.resolve', self.label, strict)
            return self.value.resolve(strict=strict)
        def lstat(self):
            nonlocal stat_calls
            stat_calls += 1
            event('path.lstat', stat_calls, path_value(self.value))
            value = self.value.lstat()
            event('path.metadata', stat_calls, metadata(value))
            return value
        def is_symlink(self):
            result = self.value.is_symlink()
            event('digest.is_symlink' if digest_active else 'path.is_symlink', result)
            return result

    class Cache(dict):
        def get(self, key, default=None):
            event('cache.get')
            return super().get(key, default)
        def __setitem__(self, key, value):
            event('cache.set')
            return super().__setitem__(key, value)

    class OS:
        def __getattr__(self, name):
            return getattr(os, name)
        def open(self, path, flags):
            event('os.open', path_value(Path(os.fspath(path))), flags)
            return os.open(path, flags)
        def fstat(self, descriptor):
            result = os.fstat(descriptor)
            event('os.fstat', metadata(result))
            return result
        def read(self, descriptor, count):
            result = os.read(descriptor, count)
            event('os.read', count, result.hex())
            return result
        def close(self, descriptor):
            event('os.close')
            return os.close(descriptor)

    def regular(mode):
        result = stat.S_ISREG(mode)
        event('digest.S_ISREG' if digest_active else 'S_ISREG', result)
        return result
    def cache_identity(value):
        result = None if recipe.get('mode') == 'null-identity' else normalization._managed_resume_digest_cache_identity(value)
        event('cache.identity', None if result is None else [str(part) for part in result])
        return result
    def modified(value):
        result = normalization._resume_modified_at(value)
        event('modified_at', result)
        return result
    def clock():
        event('clock', now.isoformat())
        return now
    def private_digest(path):
        nonlocal digest_active
        digest_active = True
        event('private_digest')
        try:
            return storage.ResumeStorageMixin._private_file_digest(path)
        finally:
            digest_active = False

    instance = SimpleNamespace(resume_files_path=ObservedPath(files), _now_datetime=clock,
                               _private_file_digest=private_digest)
    instance._managed_resume_path = lambda record: storage.ResumeStorageMixin._managed_resume_path(instance, record)
    previous = storage._RUNTIME_PROVIDER
    storage._bind_runtime(lambda: dict(os=OS(), stat=SimpleNamespace(S_ISREG=regular),
        timedelta=timedelta, RESUME_MAX_BYTES=constants.RESUME_MAX_BYTES,
        OVERVIEW_DIGEST_CACHE_SECONDS=constants.OVERVIEW_DIGEST_CACHE_SECONDS,
        _resume_modified_at=modified, _managed_resume_digest_cache_identity=cache_identity))
    cache = None if recipe.get('mode') == 'omitted' else Cache()

    def cache_state():
        if cache is None:
            return None
        return [pool.add(dict(keyRef=next(ref for ref in refs if nodes[ref] is key),
                     identity=[str(part) for part in entry['identity']],
                     checkedAt=entry['checkedAt'].isoformat(), digest=entry['digest']))
                for key, entry in cache.items()]

    before = snapshot(root, pool)
    calls = []
    try:
        count = len(refs) if refs else 1
        for index in range(count):
            events, stat_calls = [], 0
            file = nodes[recipe['file_ref']] if recipe['kind'] == 'file' else (
                1 if recipe.get('mode') == 'invalid-file' else
                'missing.bin' if recipe.get('mode') in ('missing', 'leaf') else 'file.bin')
            record = Record(storageKind='managed', managedFile=file)
            if refs:
                record['id'] = nodes[refs[index]]
            record_before = {key: typed(value) for key, value in record.items()}
            identities_before = {key: id(value) for key, value in record.items()}
            cache_before = pool.add(cache_state())
            result, error = None, None
            try:
                if recipe['kind'] == 'file':
                    result = instance._managed_resume_path(record)
                else:
                    result = storage.ResumeStorageMixin._managed_resume_observation(instance, record, digest_cache=cache)
            except Exception as caught:
                error = error_record(caught)
            record_after = {key: typed(value) for key, value in record.items()}
            calls.append(dict(keyRef=refs[index] if refs else None, recordBefore=pool.add(record_before),
                              recordAfter=pool.add(record_after), recordIdentityPreserved=identities_before == {
                                  key: id(value) for key, value in record.items()},
                              result=result, error=error, events=events,
                              cacheBefore=cache_before, cacheAfter=pool.add(cache_state())))
    finally:
        storage._bind_runtime(previous)
    keys = [nodes[ref] for ref in refs]
    return dict(id=recipe['id'], nodes=nodes_used, calls=calls,
                identity=[[a is b for b in keys] for a in keys],
                equality=[[a == b for b in keys] for a in keys],
                treeBefore=before, treeAfter=snapshot(root, pool))
