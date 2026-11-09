"""Owned-file reference for observation/cache decisions; no Store initialization."""
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
from job_apply_store.constants import RESUME_MAX_BYTES, OVERVIEW_DIGEST_CACHE_SECONDS
from job_apply_store.domains.resumes import storage
from job_apply_store.normalization import _managed_resume_digest_cache_identity, _resume_modified_at

NOW = datetime(2026, 1, 2, tzinfo=timezone.utc)
DATA = b'synthetic observation bytes'
CASES = ['normal', 'cache-empty', 'cache-fresh', 'cache-zero-age', 'cache-expired',
         'cache-future', 'cache-wrong-identity', 'cache-disabled', 'missing',
         'directory', 'symlink', 'oversized', 'digest-none', 'after-read-change',
         'first-stat-error', 'second-stat-error', 'cache-missing-time', 'cache-missing-digest']


def snapshot(root):
    rows = []
    for path in [root, *sorted(root.iterdir())]:
        metadata = path.lstat()
        rows.append({'path': '.' if path == root else path.name,
                     'mode': stat.S_IMODE(metadata.st_mode),
                     'mtimeNs': str(metadata.st_mtime_ns),
                     'kind': 'symlink' if path.is_symlink() else 'directory' if path.is_dir() else 'file',
                     'target': os.readlink(path) if path.is_symlink() else None,
                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() and not path.is_symlink() else None})
    return rows


def observe(identifier):
    with tempfile.TemporaryDirectory(prefix='managed-observation-') as temporary:
        root = Path(temporary)
        path = root / 'synthetic.bin'
        if identifier == 'directory':
            path.mkdir()
        elif identifier == 'symlink':
            (root / 'target.bin').write_bytes(DATA)
            path.symlink_to('target.bin')
        elif identifier != 'missing':
            path.write_bytes(DATA if identifier != 'oversized' else b'x' * (RESUME_MAX_BYTES + 1))
            os.utime(path, ns=(1767225600000000000, 1767225600000000000))
        calls = {'path': 0, 'stat': 0, 'symlink': 0, 'digest': 0, 'clock': 0}
        initial = path.stat() if path.exists() else None
        cache = None
        if identifier.startswith('cache-'):
            cache = {}
            if identifier != 'cache-empty':
                identity = _managed_resume_digest_cache_identity(initial)
                age = {'cache-zero-age': 0, 'cache-expired': OVERVIEW_DIGEST_CACHE_SECONDS,
                       'cache-future': -1}.get(identifier, 1)
                cache['synthetic'] = {'identity': identity, 'digest': 'cached-marker',
                                      'checkedAt': NOW - timedelta(seconds=age)}
                if identifier == 'cache-wrong-identity':
                    cache['synthetic']['identity'] = ('wrong',)
                if identifier == 'cache-missing-time':
                    del cache['synthetic']['checkedAt']
                if identifier == 'cache-missing-digest':
                    del cache['synthetic']['digest']

        def cache_view():
            if cache is None:
                return None
            return {key: {'fields': sorted(value), 'digest': value.get('digest'),
                          'ageSeconds': (NOW - value['checkedAt']).total_seconds() if 'checkedAt' in value else None,
                          'identityMatchesInitial': value.get('identity') == _managed_resume_digest_cache_identity(initial)}
                    for key, value in cache.items()}

        class ObservedPath:
            def lstat(self):
                calls['stat'] += 1
                if (identifier == 'first-stat-error' and calls['stat'] == 1
                        or identifier == 'second-stat-error' and calls['stat'] == 2):
                    raise OSError('synthetic stat failure')
                return path.lstat()

            def is_symlink(self):
                calls['symlink'] += 1
                return path.is_symlink()

        def managed_path(record):
            calls['path'] += 1
            return ObservedPath()

        def clock():
            calls['clock'] += 1
            return NOW

        def digest(observed_path):
            calls['digest'] += 1
            if identifier == 'digest-none':
                return None
            value = storage.ResumeStorageMixin._private_file_digest(path)
            if identifier == 'after-read-change':
                path.write_bytes(DATA + b' changed')
            return value

        instance = SimpleNamespace(_managed_resume_path=managed_path,
                                   _now_datetime=clock, _private_file_digest=digest)
        previous = storage._RUNTIME_PROVIDER
        storage._bind_runtime(lambda: {
            'os': os, 'stat': stat, 'hashlib': hashlib, 'timedelta': timedelta,
            'RESUME_MAX_BYTES': RESUME_MAX_BYTES,
            'OVERVIEW_DIGEST_CACHE_SECONDS': OVERVIEW_DIGEST_CACHE_SECONDS,
            '_resume_modified_at': _resume_modified_at,
            '_managed_resume_digest_cache_identity': lambda metadata:
                _managed_resume_digest_cache_identity(metadata, platform_name='nt' if identifier == 'cache-disabled' else None),
        })
        before = snapshot(root)
        cache_before = cache_view()
        try:
            try:
                outcome = {'kind': 'value', 'value': storage.ResumeStorageMixin._managed_resume_observation(
                    instance, {'id': 'synthetic'}, digest_cache=cache)}
            except Exception as error:
                outcome = {'kind': 'error', 'name': type(error).__name__}
        finally:
            storage._bind_runtime(previous)
        after = snapshot(root)
        return {'id': identifier, 'outcome': outcome, 'calls': calls,
                'before': before, 'after': after, 'unchanged': before == after,
                'cacheBefore': cache_before, 'cacheAfter': cache_view()}


def capture():
    sources = ['scripts/job_apply_store/domains/resumes/storage.py',
               'scripts/job_apply_store/normalization.py', 'scripts/job_apply_store/constants.py']
    return {'schemaVersion': 1, 'profile': {'python': platform.python_version(),
            'implementation': platform.python_implementation(), 'platform': sys.platform},
            'sources': {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in sources},
            'cacheSeconds': OVERVIEW_DIGEST_CACHE_SECONDS, 'cases': [observe(name) for name in CASES]}


if __name__ == '__main__':
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write('managed_observation_reference_input_rejected\n')
        sys.exit(2)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
