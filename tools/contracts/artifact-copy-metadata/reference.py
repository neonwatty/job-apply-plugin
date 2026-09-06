"""Actual copy_critical/copy2 on owned metadata fixtures, including scoped faults."""
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


support = load('copy_metadata_support', HERE / 'support.py')
artifacts = load('actual_artifacts', ROOT / 'scripts/smoke/artifacts.py')
CASES = [
    ('fractional', 1700000000123456789),
    ('negative', -600),
    ('near-carry', 1767225600999999500),
    ('xattrs', 1700000000987654321),
    ('before-copy', 1700000000123456789),
    ('after-data', 1700000000123456789),
    ('after-copy', 1700000000123456789),
    ('utime-error', 1700000000123456789),
    ('chmod-error', 1700000000123456789),
]


def capture_case(identifier, timestamp):
    with tempfile.TemporaryDirectory(prefix='copy-metadata-reference-') as temporary:
        root = Path(temporary).resolve()
        source, target = root / 'source', root / 'target'
        support.fixture(source, 'source', timestamp)
        support.fixture(target, 'target', support.BASE_NS)
        focus = target / 'runtime/data.bin'
        if identifier == 'xattrs':
            if support.xattr_backend() is None:
                return {'id': identifier, 'status': 'unavailable', 'reason': 'xattr API absent'}
            try:
                support.set_attribute(source / 'runtime/data.bin', support.ATTRIBUTE, b'synthetic\x00\xff')
                support.set_attribute(focus, 'user.job_apply_target_only', b'retained')
            except OSError as error:
                if error.errno not in (errno.ENOTSUP, errno.EOPNOTSUPP):
                    raise
                return {'id': identifier, 'status': 'unavailable',
                        'reason': 'xattr filesystem unsupported', 'errno': error.errno}
        before_source, before_target = support.snapshot(source), support.snapshot(target)
        paths_before = sorted(path.relative_to(root).as_posix() for path in root.rglob('*'))
        events = []
        original_copy, original_utime, original_chmod = shutil.copy2, os.utime, os.chmod

        def copied(src, dst, **kwargs):
            relative = Path(dst).relative_to(target).as_posix()
            assert relative in support.FILES
            assert src == source / relative
            assert dst == target / relative
            assert kwargs == {'follow_symlinks': False}
            events.append('copy:' + relative)
            if Path(dst) == focus and identifier == 'before-copy':
                raise OSError(errno.EIO, 'synthetic before copy')
            if Path(dst) == focus and identifier == 'after-data':
                shutil.copyfile(src, dst, **kwargs)
                raise OSError(errno.EIO, 'synthetic after data')
            result = original_copy(src, dst, **kwargs)
            if Path(dst) == focus and identifier == 'after-copy':
                raise OSError(errno.EIO, 'synthetic after copy')
            return result

        def timed(path, *args, **kwargs):
            if Path(path) == focus:
                assert args == ()
                assert set(kwargs) == {'ns', 'follow_symlinks'}
                assert kwargs['follow_symlinks'] is True
                assert isinstance(kwargs['ns'], tuple) and len(kwargs['ns']) == 2
                assert all(isinstance(value, int) for value in kwargs['ns'])
                # Access time can change while copyfile reads the source. This
                # package binds mtime, not the observed source access time.
                assert kwargs['ns'][1] == (source / 'runtime/data.bin').stat().st_mtime_ns
            if Path(path) == focus and identifier == 'utime-error':
                events.append('fault:utime')
                raise OSError(errno.EIO, 'synthetic utime')
            return original_utime(path, *args, **kwargs)

        def moded(path, *args, **kwargs):
            if Path(path) == focus:
                assert args == ((source / 'runtime/data.bin').stat().st_mode & 0o7777,)
                assert kwargs == {'follow_symlinks': True}
            if Path(path) == focus and identifier == 'chmod-error':
                events.append('fault:chmod')
                raise OSError(errno.EIO, 'synthetic chmod')
            return original_chmod(path, *args, **kwargs)

        try:
            with patch.object(shutil, 'copy2', copied), patch.object(os, 'utime', timed), patch.object(os, 'chmod', moded):
                artifacts.copy_critical(source, target)
            outcome = {'kind': 'value', 'value': None}
        except OSError as error:
            outcome = {'kind': 'error', 'name': type(error).__name__, 'errno': error.errno}
        return {'id': identifier, 'status': 'observed', 'requestedNs': str(timestamp),
                'native': identifier in ('fractional', 'negative', 'near-carry', 'xattrs'),
                'outcome': outcome, 'events': events,
                'sourceBefore': before_source, 'sourceAfter': support.snapshot(source),
                'targetBefore': before_target, 'targetAfter': support.snapshot(target),
                'pathsBefore': paths_before,
                'pathsAfter': sorted(path.relative_to(root).as_posix() for path in root.rglob('*'))}


def capture():
    source = ROOT / 'scripts/smoke/artifacts.py'
    return {'schemaVersion': 1, 'profile': {'implementation': platform.python_implementation(),
            'python': platform.python_version(), 'platform': sys.platform,
            'xattrBackend': support.xattr_backend(), 'pythonXattrAPI': hasattr(os, 'setxattr')},
            'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'shutilSha256': hashlib.sha256(Path(shutil.__file__).read_bytes()).hexdigest(),
            'cases': [capture_case(*case) for case in CASES]}


if __name__ == '__main__':
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write('artifact_copy_metadata_input_rejected\n')
        sys.exit(2)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
