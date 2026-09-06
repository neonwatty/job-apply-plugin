"""Owned synthetic copy fixtures; metadata is sampled before content reads."""
import hashlib
import os
import stat
import subprocess
import sys
from pathlib import Path

FILES = sorted(['.codex-plugin/plugin.json', 'scripts/job-apply-store.py',
                'scripts/job-apply-task.py', 'scripts/job-apply-attempt.py',
                'scripts/job-apply-workspace.py', 'skills/answer-memory/SKILL.md',
                'skills/job-apply/SKILL.md', 'runtime/data.bin'])
TREES = ['runtime', 'scripts/job_apply_store', 'scripts/job_apply_workspace', 'workspace']
FOCUS = 'runtime/data.bin'
ATIME = 1600000000123456789
MTIME = 1700000000987654321
POST_ATIME = 1500000000111111111
POST_MTIME = 1750000000222222222
ATTRIBUTE = 'user.job_apply_copy_order'


def payload(label, relative):
    return (label + ':' + relative).encode() + b'\x00\xff'


def fixture(root, label):
    root.mkdir()
    for tree in TREES:
        (root / tree).mkdir(parents=True, exist_ok=True)
    for relative in FILES:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload(label, relative))
        path.chmod(0o640 if label == 'source' else 0o600)
        os.utime(path, ns=(ATIME if label == 'source' else ATIME - 1000000000,
                           MTIME if label == 'source' else MTIME - 1000000000))


def metadata(root):
    rows = []
    for relative in FILES:
        path = root / relative
        try:
            info = path.stat()
        except FileNotFoundError:
            rows.append({'path': relative, 'missing': True})
            continue
        rows.append({'path': relative, **stat_fields(info)})
    return rows


def stat_fields(info):
    return {'atimeNs': str(info.st_atime_ns), 'mtimeNs': str(info.st_mtime_ns),
            'mode': stat.S_IMODE(info.st_mode), 'flags': getattr(info, 'st_flags', None),
            'size': info.st_size}


def digests(root):
    return {relative: hashlib.sha256((root / relative).read_bytes()).hexdigest()
            for relative in FILES if (root / relative).exists()}


def paths(root):
    return sorted(path.relative_to(root).as_posix() for path in root.rglob('*'))


def xattr_backend():
    if hasattr(os, 'setxattr'):
        return 'python-os'
    if sys.platform == 'darwin' and Path('/usr/bin/xattr').is_file():
        return 'macos-xattr-tool'
    return None


def xattr_command(args):
    result = subprocess.run(['/usr/bin/xattr', *args], capture_output=True, timeout=3)
    if result.returncode:
        raise RuntimeError('owned xattr command failed: ' + result.stderr.decode('utf8'))
    return result.stdout


def set_attribute(path, value):
    if xattr_backend() == 'python-os':
        os.setxattr(path, ATTRIBUTE, value)
    else:
        xattr_command(['-wx', ATTRIBUTE, value.hex(), str(path)])


def attribute(path):
    if not path.exists():
        return None
    if xattr_backend() == 'python-os':
        if ATTRIBUTE not in os.listxattr(path):
            return None
        return os.getxattr(path, ATTRIBUTE).hex()
    names = xattr_command([str(path)]).decode('utf8').splitlines()
    if ATTRIBUTE not in names:
        return None
    return bytes.fromhex(xattr_command(['-px', ATTRIBUTE, str(path)]).decode('ascii')).hex()
