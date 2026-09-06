"""Fixed owned artifact fixtures and metadata observations."""
import hashlib
import os
import stat
import subprocess
import sys
from pathlib import Path

FIXED = ['.codex-plugin/plugin.json', 'scripts/job-apply-store.py',
         'scripts/job-apply-task.py', 'scripts/job-apply-attempt.py',
         'scripts/job-apply-workspace.py', 'skills/answer-memory/SKILL.md',
         'skills/job-apply/SKILL.md']
TREES = ['runtime', 'scripts/job_apply_store', 'scripts/job_apply_workspace', 'workspace']
FILES = sorted(FIXED + ['runtime/data.bin'])
BASE_NS = 1700000000000000000
ATTRIBUTE = 'user.job_apply_synthetic'


def xattr_backend():
    if hasattr(os, 'setxattr'):
        return 'python-os'
    if sys.platform == 'darwin' and Path('/usr/bin/xattr').is_file():
        return 'macos-xattr-tool'
    return None


def command(args):
    result = subprocess.run(['/usr/bin/xattr', *args], capture_output=True, timeout=3)
    if result.returncode:
        raise RuntimeError('owned xattr command failed')
    return result.stdout


def set_attribute(path, name, value):
    if xattr_backend() == 'python-os':
        os.setxattr(path, name, value)
    else:
        command(['-wx', name, value.hex(), str(path)])


def attributes(path):
    if xattr_backend() == 'python-os':
        return {name: os.getxattr(path, name).hex() for name in sorted(os.listxattr(path)) if name.startswith('user.job_apply_')}
    if xattr_backend() == 'macos-xattr-tool':
        names = command([str(path)]).decode('utf8').splitlines()
        return {name: bytes.fromhex(command(['-px', name, str(path)]).decode('ascii')).hex()
                for name in sorted(names) if name.startswith('user.job_apply_')}
    return None


def fixture(root, label, timestamp):
    root.mkdir()
    for tree in TREES:
        (root / tree).mkdir(parents=True, exist_ok=True)
    for relative in FILES:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(label.encode() + b':' + relative.encode() + b'\x00\xff')
        path.chmod(0o640 if label == 'source' else 0o600)
        os.utime(path, ns=(timestamp, timestamp))


def snapshot(root):
    rows = []
    for relative in FILES:
        path = root / relative
        data = path.read_bytes()
        info = path.stat()
        observed_attributes = attributes(path) if relative == 'runtime/data.bin' else None
        rows.append({'path': relative, 'mode': stat.S_IMODE(info.st_mode),
                     'mtimeNs': str(info.st_mtime_ns), 'size': info.st_size,
                     'sha256': hashlib.sha256(data).hexdigest(), 'xattrs': observed_attributes,
                     'flags': getattr(info, 'st_flags', None)})
    return rows
