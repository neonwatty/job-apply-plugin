"""Actual shutil data-only operations; no input, live Store or metadata copying."""
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
if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
    sys.stderr.write('artifact_data_copy_input_rejected\n')
    raise SystemExit(2)
if os.name != 'posix':
    sys.stderr.write('artifact_data_copy_posix_required\n')
    raise SystemExit(3)
sys.path.insert(0, str(Path(__file__).parent))
import support as s
ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'scripts/smoke/artifacts.py'
spec = importlib.util.spec_from_file_location('actual_copy_artifacts', SOURCE)
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)
NATIVE = ['existing', 'new-022', 'new-077', 'empty', 'multichunk', 'same-path', 'hardlink',
          'source-fifo', 'target-fifo', 'source-missing', 'target-directory', 'source-link', 'target-link']
BUFFERED = ['existing', 'multichunk', 'source-open-error', 'target-open-error', 'read-error', 'write-error',
            'partial-read-error', 'partial-write-error', 'short-write', 'source-close-error', 'target-close-error',
            'read-both-close-error', 'write-target-close-error', 'source-close-after-error', 'target-close-after-error']
ACCELERATOR = ['fallback', 'partial-error']
PREFLIGHT = ['source-fifo', 'source-link', 'target-fifo', 'target-link']


def accelerator_name():
    if getattr(shutil, '_HAS_FCOPYFILE', False):
        return '_fastcopy_fcopyfile'
    if getattr(shutil, '_USE_CP_COPY_FILE_RANGE', False):
        return '_fastcopy_copy_file_range'
    if getattr(shutil, '_USE_CP_SENDFILE', False):
        return '_fastcopy_sendfile'
    return None


def capture(lane, case):
    with tempfile.TemporaryDirectory(prefix='artifact-data-copy-') as temporary:
        root = Path(temporary)
        src, dst = root / 'source', root / 'target'
        payload = (bytes(range(251)) * ((shutil.COPY_BUFSIZE * 2 + 17) // 251 + 1))[:shutil.COPY_BUFSIZE * 2 + 17] if case in {'multichunk', 'partial-read-error', 'partial-write-error'} else s.DATA
        if case == 'empty':
            payload = b''
        src.write_bytes(payload); src.chmod(0o640)
        dst.write_bytes(s.OLD); dst.chmod(0o600)
        if case.startswith('new-'):
            dst.unlink()
        if case in {'source-fifo', 'source-missing', 'source-link'}:
            src.unlink()
            if case == 'source-fifo': os.mkfifo(src, 0o640)
            if case == 'source-link':
                (root / 'referent').write_bytes(payload)
                src.symlink_to('referent')
                dst.unlink()
        if case in {'target-fifo', 'target-directory', 'target-link', 'hardlink'}:
            dst.unlink()
            if case == 'target-fifo': os.mkfifo(dst, 0o600)
            if case == 'target-directory': dst.mkdir()
            if case == 'target-link':
                (root / 'referent').write_bytes(s.OLD)
                (root / 'referent').chmod(0o600)
                dst.symlink_to('referent')
            if case == 'hardlink': os.link(src, dst)
        if case == 'same-path': dst = src
        for path in [root, *root.iterdir()]:
            os.utime(path, ns=(s.STAMP, s.STAMP), follow_symlinks=False)
        streams = s.Streams(src, dst, case)
        selected = accelerator_name()
        before = s.snapshot(root)
        old_umask = os.umask(0o077 if case == 'new-077' else 0o022)
        result, error = None, None
        patches = []
        try:
            patches.append(patch.object(shutil, 'open', streams.open, create=True))
            if lane == 'buffered':
                for name in ['_HAS_FCOPYFILE', '_USE_CP_COPY_FILE_RANGE', '_USE_CP_SENDFILE']:
                    if hasattr(shutil, name): patches.append(patch.object(shutil, name, False))
            elif lane == 'accelerator':
                if selected is None:
                    return {'id': lane + ':' + case, 'status': 'unavailable', 'reason': 'no selected native accelerator'}
                # This lane observes one controlled accelerator and its buffered
                # fallback. A second native helper would bypass Streams' witnesses
                # (copy_file_range can fall through to sendfile on Python 3.14).
                for flag, helper in [('_HAS_FCOPYFILE', '_fastcopy_fcopyfile'),
                                     ('_USE_CP_COPY_FILE_RANGE', '_fastcopy_copy_file_range'),
                                     ('_USE_CP_SENDFILE', '_fastcopy_sendfile')]:
                    if helper != selected and hasattr(shutil, flag):
                        patches.append(patch.object(shutil, flag, False))
                def accelerated(fsrc, fdst, *args):
                    streams.mark('accelerator', helper=selected)
                    if case == 'fallback': raise shutil._GiveupOnFastCopy(OSError(errno.ENOTSUP, 'synthetic unsupported'))
                    data = fsrc.read(7)
                    fdst.write(data); fdst.flush()
                    streams.mark('accelerator-mutation', target=s.digest(dst.read_bytes()))
                    raise s.InjectedFailure('accelerator-after-write')
                patches.append(patch.object(shutil, selected, accelerated))
            for replacement in patches: replacement.start()
            try:
                result = shutil.copyfile(src, dst, follow_symlinks=False)
            except BaseException as caught:
                error = caught
            return {'id': lane + ':' + case, 'status': 'observed', 'umask': 0o077 if case == 'new-077' else 0o022,
                    'evidence': 'native' if lane == 'native' else 'controlled-' + lane,
                    'bufferSize': shutil.COPY_BUFSIZE, 'accelerator': selected,
                    'sourceInput': s.digest(payload), 'targetInput': s.digest(s.OLD),
                    'value': str(result.relative_to(root)) if error is None else None,
                    'error': s.error_receipt(error, root), 'calls': streams.calls,
                    'descriptors': streams.witnesses(), 'before': before, 'after': s.snapshot(root)}
        finally:
            for replacement in reversed(patches): replacement.stop()
            os.umask(old_umask)
            streams.cleanup()


def preflight(case):
    with tempfile.TemporaryDirectory(prefix='artifact-data-preflight-') as temporary:
        root = Path(temporary)
        src, dst = root / 'source', root / 'target'
        for base in [src, dst]:
            base.mkdir()
            for relative in artifacts.FIXED_CRITICAL_FILES:
                path = base / relative; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((base.name + ':' + relative).encode())
            for relative in artifacts.CRITICAL_TREES:
                (base / relative).mkdir(parents=True, exist_ok=True)
            (base / 'runtime/z.bin').write_bytes(base.name.encode())
        base = src if case.startswith('source') else dst
        focus = base / 'runtime/z.bin'
        focus.unlink()
        if case.endswith('fifo'): os.mkfifo(focus)
        else: focus.symlink_to('../scripts/job-apply-store.py')
        before = s.snapshot(root)
        calls, error = [], None
        def copied(*args, **kwargs):
            calls.append('copy2')
            raise AssertionError('preflight must reject before copying')
        with patch.object(shutil, 'copy2', copied):
            try: artifacts.copy_critical(src, dst)
            except BaseException as caught: error = caught
        return {'id': 'preflight:' + case, 'status': 'observed', 'calls': calls,
                'error': s.error_receipt(error, root), 'before': before, 'after': s.snapshot(root)}


def hash_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


print(json.dumps({'schemaVersion': 1, 'profile': {'python': platform.python_version(),
    'implementation': platform.python_implementation(), 'platform': sys.platform, 'osName': os.name,
    'bufferSize': shutil.COPY_BUFSIZE, 'accelerator': accelerator_name(),
    'executable': str(Path(sys.executable).resolve()), 'executableSha256': hash_file(sys.executable)},
    'sources': {'scripts/smoke/artifacts.py': hash_file(SOURCE)},
    'stdlib': {'shutil': {'path': shutil.__file__, 'sha256': hash_file(shutil.__file__)}},
    'cases': [capture(lane, case) for lane, ids in [('native', NATIVE), ('buffered', BUFFERED), ('accelerator', ACCELERATOR)] for case in ids]
             + [preflight(case) for case in PREFLIGHT]}, ensure_ascii=True))
