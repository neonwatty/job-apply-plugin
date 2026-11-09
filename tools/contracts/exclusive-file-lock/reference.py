"""Actual POSIX Store lock ordering on owned files, including injected failures."""
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
sys.path.insert(0, str(ROOT / 'scripts'))
from job_apply_store.io import exclusive_file_lock

CASES = {
    'normal': [], 'parent-mode-error': ['parent-mode'], 'open-error': ['open'],
    'file-mode-error': ['file-mode'], 'acquire-error': ['acquire'],
    'body-error': ['body'], 'release-error': ['release'], 'close-error': ['close'],
    'body-release-error': ['body', 'release'], 'body-close-error': ['body', 'close'],
    'acquire-release-error': ['acquire', 'release'], 'release-close-error': ['release', 'close'],
    'existing-file': [], 'symlink-file': [],
}


def snapshot(root):
    rows = []
    for path in [root, *sorted(root.iterdir())]:
        info = path.lstat()
        link = stat.S_ISLNK(info.st_mode)
        regular = stat.S_ISREG(info.st_mode)
        rows.append({'path': '.' if path == root else path.name,
                     'mode': stat.S_IMODE(info.st_mode),
                     'kind': 'link' if link else 'file' if regular else 'directory',
                     'bytes': path.read_bytes().hex() if regular else None,
                     'target': os.readlink(path) if link else None})
    return rows


def observe(identifier, failures):
    import fcntl
    with tempfile.TemporaryDirectory(prefix='exclusive-lock-reference-') as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        path = root / 'synthetic.lock'
        if identifier == 'existing-file':
            path.write_bytes(b'synthetic existing lock')
            path.chmod(0o644)
        if identifier == 'symlink-file':
            target = root / 'target'
            target.write_bytes(b'synthetic target')
            target.chmod(0o644)
            path.symlink_to('target')
        before = snapshot(root)
        calls = []
        descriptors = set()
        native_flock = fcntl.flock

        def step(name):
            calls.append(name)
            if name in failures:
                raise OSError(5, f'synthetic {name}')

        def chmod(candidate, mode):
            assert candidate in (root, path)
            assert mode == (0o700 if candidate == root else 0o600)
            step('parent-mode' if candidate == root else 'file-mode')
            os.chmod(candidate, mode)

        def opened(candidate, flags, mode):
            assert candidate == path
            assert flags == os.O_RDWR | os.O_CREAT
            assert mode == 0o600
            step('open')
            descriptor = os.open(candidate, flags, mode)
            descriptors.add(descriptor)
            return descriptor

        def flock(descriptor, operation):
            assert descriptor in descriptors
            assert operation in (fcntl.LOCK_EX, fcntl.LOCK_UN)
            step('acquire' if operation == fcntl.LOCK_EX else 'release')
            native_flock(descriptor, operation)

        def closed(descriptor):
            step('close')
            os.close(descriptor)
            descriptors.remove(descriptor)

        runtime_os = SimpleNamespace(name='posix', chmod=chmod, open=opened,
                                     close=closed, O_RDWR=os.O_RDWR, O_CREAT=os.O_CREAT)
        try:
            with patch.object(fcntl, 'flock', flock):
                try:
                    with exclusive_file_lock(path, _runtime={'os': runtime_os}):
                        step('body')
                    outcome = {'kind': 'value'}
                except OSError as error:
                    outcome = {'kind': 'error', 'name': type(error).__name__,
                               'errno': error.errno, 'message': error.strerror}
            return {'id': identifier, 'failures': failures, 'calls': calls, 'outcome': outcome,
                    'openDescriptorsAtReturn': len(descriptors), 'before': before, 'after': snapshot(root)}
        finally:
            # Witness leaked descriptors before cleanup; never leak oracle resources.
            for descriptor in descriptors:
                os.close(descriptor)


def capture():
    sources = ['scripts/job_apply_store/io.py', 'scripts/job_apply_store/constants.py',
               'scripts/job_apply_store/errors.py']
    profile = {'python': platform.python_version(), 'platform': sys.platform,
               'implementation': platform.python_implementation()}
    receipt = {'schemaVersion': 1, 'profile': profile,
               'sources': {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in sources}}
    if os.name == 'nt':
        return {**receipt, 'status': 'unavailable', 'reason': 'POSIX flock reference; native Windows required', 'cases': []}
    return {**receipt, 'status': 'observed', 'cases': [observe(name, failures) for name, failures in CASES.items()]}


if __name__ == '__main__':
    if len(sys.argv) != 1 or sys.stdin.read().strip():
        raise SystemExit('This reference accepts no caller data')
    print(json.dumps(capture(), sort_keys=True))
