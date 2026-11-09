#!/usr/bin/env python3
"""Capture actual copy2 ordering only on fixed, disposable artifact trees."""
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
    sys.stderr.write('artifact_copy_order_input_rejected\n')
    raise SystemExit(2)
sys.path.insert(0, str(Path(__file__).parent))
import support as s

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'scripts/smoke/artifacts.py'
spec = importlib.util.spec_from_file_location('actual_artifacts', SOURCE)
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)
IDS = ['native-times', 'post-data-times', 'source-stat-error', 'utime-error',
       'source-flags', 'clear-target-flags', 'flags-ENOTSUP', 'flags-EOPNOTSUPP',
       'flags-EIO', 'chmod-notimplemented', 'xattr-existing', 'xattr-new']


def capture(case_id):
    flag_case = 'flags' in case_id
    xattr_case = case_id.startswith('xattr-')
    if flag_case and not (hasattr(os, 'chflags') and hasattr(stat, 'UF_NODUMP')):
        return {'id': case_id, 'status': 'unavailable', 'reason': 'native flags API absent'}
    if xattr_case and s.xattr_backend() is None:
        return {'id': case_id, 'status': 'unavailable', 'reason': 'native xattr backend absent'}
    with tempfile.TemporaryDirectory(prefix='copy-order-') as directory:
        root = Path(directory).resolve()
        source, target = root / 'source', root / 'target'
        s.fixture(source, 'source')
        s.fixture(target, 'target')
        src, dst = source / s.FOCUS, target / s.FOCUS
        try:
            if case_id == 'source-flags' or case_id.startswith('flags-'):
                os.chflags(src, stat.UF_NODUMP)
            if case_id == 'clear-target-flags':
                os.chflags(dst, stat.UF_NODUMP)
            if xattr_case:
                s.set_attribute(src, b'source\x00\xff')
                s.set_attribute(dst, b'target\x00\xfe')
                if case_id == 'xattr-new':
                    dst.unlink()
        except OSError as error:
            if error.errno not in (errno.ENOTSUP, errno.EOPNOTSUPP):
                raise
            return {'id': case_id, 'status': 'unavailable',
                    'reason': 'native metadata unsupported', 'errno': error.errno}
        try:
            before = {'source': s.metadata(source), 'target': s.metadata(target)}
            paths_before = s.paths(root)
            attrs_before = {'source': s.attribute(src), 'target': s.attribute(dst)} if xattr_case else None
            events = []
            active = False
            original_stat, original_utime = os.stat, os.utime
            original_chmod = os.chmod
            original_flags = getattr(os, 'chflags', None)
            original_copy, original_meta = shutil.copyfile, shutil.copystat
            original_xattrs = shutil._copyxattr

            def copied(received_src, received_dst, **kwargs):
                relative = Path(received_src).relative_to(source).as_posix()
                assert relative in s.FILES
                assert Path(received_dst) == target / relative
                assert kwargs == {'follow_symlinks': False}
                events.append({'op': 'copy', 'path': relative})
                result = original_copy(received_src, received_dst, **kwargs)
                if relative == s.FOCUS and case_id == 'post-data-times':
                    original_utime(src, ns=(s.POST_ATIME, s.POST_MTIME))
                return result

            def metadata_copy(received_src, received_dst, **kwargs):
                nonlocal active
                assert Path(received_dst) == target / Path(received_src).relative_to(source)
                assert kwargs == {'follow_symlinks': False}
                active = Path(received_src) == src
                try:
                    return original_meta(received_src, received_dst, **kwargs)
                finally:
                    active = False

            def sampled(path, *args, **kwargs):
                if active and Path(path) == src:
                    assert args == () and kwargs == {'follow_symlinks': True}
                    if case_id == 'source-stat-error':
                        events.append({'op': 'stat-error'})
                        raise OSError(errno.EIO, 'synthetic source stat')
                    info = original_stat(path, **kwargs)
                    events.append({'op': 'stat', **s.stat_fields(info)})
                    return info
                return original_stat(path, *args, **kwargs)

            def timed(path, *args, **kwargs):
                if active:
                    assert Path(path) == dst and args == ()
                    assert set(kwargs) == {'ns', 'follow_symlinks'}
                    assert kwargs['follow_symlinks'] is True
                    info = original_stat(src)
                    assert kwargs['ns'] == (info.st_atime_ns, info.st_mtime_ns)
                    events.append({'op': 'utime', 'atimeNs': str(kwargs['ns'][0]),
                                   'mtimeNs': str(kwargs['ns'][1]), 'follow': True})
                    if case_id == 'utime-error':
                        raise OSError(errno.EIO, 'synthetic utime')
                return original_utime(path, *args, **kwargs)

            def copied_xattrs(received_src, received_dst, **kwargs):
                if active:
                    assert Path(received_src) == src and Path(received_dst) == dst
                    assert kwargs == {'follow_symlinks': True}
                    events.append({'op': 'xattrs', 'follow': True})
                return original_xattrs(received_src, received_dst, **kwargs)

            def moded(path, mode, **kwargs):
                if active:
                    assert Path(path) == dst and kwargs == {'follow_symlinks': True}
                    assert mode == stat.S_IMODE(original_stat(src).st_mode)
                    events.append({'op': 'chmod', 'mode': mode, 'follow': True})
                    if case_id == 'chmod-notimplemented':
                        raise NotImplementedError('synthetic chmod')
                return original_chmod(path, mode, **kwargs)

            def flagged(path, flags, **kwargs):
                if active:
                    assert Path(path) == dst and kwargs == {'follow_symlinks': True}
                    assert flags == original_stat(src).st_flags
                    events.append({'op': 'chflags', 'flags': flags, 'follow': True})
                    if case_id.startswith('flags-'):
                        raise OSError(getattr(errno, case_id.removeprefix('flags-')), 'synthetic flags')
                return original_flags(path, flags, **kwargs)

            with patch.object(shutil, 'copyfile', copied), patch.object(shutil, 'copystat', metadata_copy), \
                    patch.object(os, 'stat', sampled), patch.object(os, 'utime', timed), \
                    patch.object(os, 'chmod', moded), patch.object(shutil, '_copyxattr', copied_xattrs):
                with patch.object(os, 'chflags', flagged) if original_flags else null_patch():
                    try:
                        value = artifacts.copy_critical(source, target)
                        assert value is None
                        outcome = {'kind': 'value', 'value': None}
                    except OSError as error:
                        outcome = {'kind': 'error', 'name': type(error).__name__, 'errno': error.errno}
            # Both trees' metadata is captured before attribute tools or verification reads.
            after = {'source': s.metadata(source), 'target': s.metadata(target)}
            paths_after = s.paths(root)
            attrs_after = {'source': s.attribute(src), 'target': s.attribute(dst)} if xattr_case else None
            hashes = {'source': s.digests(source), 'target': s.digests(target)}
            return {'id': case_id, 'status': 'observed',
                    'injected': case_id in ('post-data-times', 'source-stat-error', 'utime-error',
                                           'flags-ENOTSUP', 'flags-EOPNOTSUPP', 'flags-EIO',
                                           'chmod-notimplemented'),
                    'events': events, 'outcome': outcome,
                    'before': before, 'after': after, 'hashes': hashes,
                    'attributesBefore': attrs_before, 'attributesAfter': attrs_after,
                    'pathsBefore': paths_before, 'pathsAfter': paths_after}
        finally:
            if hasattr(os, 'chflags'):
                for path in (src, dst):
                    if path.exists():
                        os.chflags(path, 0)


class null_patch:
    def __enter__(self):
        return None

    def __exit__(self, *args):
        return False


print(json.dumps({'schemaVersion': 1, 'profile': {
    'implementation': platform.python_implementation(), 'python': platform.python_version(),
    'platform': sys.platform, 'xattrBackend': s.xattr_backend(),
    'pythonXattrAPI': hasattr(os, 'setxattr'), 'flagsAPI': hasattr(os, 'chflags'),
    'nodump': getattr(stat, 'UF_NODUMP', None)},
    'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'shutilSha256': hashlib.sha256(Path(shutil.__file__).read_bytes()).hexdigest(),
    'cases': [capture(case_id) for case_id in IDS]}, sort_keys=True))
