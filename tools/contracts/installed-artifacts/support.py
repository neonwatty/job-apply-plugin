"""Synthetic fixture construction and non-following observation only."""
import hashlib
import os
from pathlib import Path
import shutil
import stat

FIXED = [
    '.codex-plugin/plugin.json', 'scripts/job-apply-store.py',
    'scripts/job-apply-task.py', 'scripts/job-apply-attempt.py',
    'scripts/job-apply-workspace.py', 'skills/answer-memory/SKILL.md',
    'skills/job-apply/SKILL.md',
]
TREES = ['skills', 'runtime', 'scripts/job_apply_store', 'scripts/job_apply_workspace', 'workspace']
FILES = FIXED + ['runtime/nested/codec.js', 'scripts/job_apply_store/io.py',
                 'scripts/job_apply_workspace/handler.py', 'workspace/app.js',
                 'skills/job-apply/references/runtime-contract.md', 'skills/job-search/SKILL.md']
STAMP = 1700000000000000000


def fixture(root):
    root.mkdir()
    for relative in FILES:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'synthetic:' + relative.encode() + b'\x00\xff\n')
        path.chmod(0o640)
        os.utime(path, ns=(STAMP, STAMP))
    return root


def remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def snapshot(root):
    rows = []

    def visit(path):
        info = path.lstat()
        relative = path.relative_to(root).as_posix()
        kind = ('symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode)
                else 'file' if stat.S_ISREG(info.st_mode) else 'fifo')
        rows.append({'path': relative, 'kind': kind, 'mode': stat.S_IMODE(info.st_mode),
                     'mtimeNs': str(info.st_mtime_ns),
                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest() if kind == 'file' else None,
                     'target': os.readlink(path) if kind == 'symlink' else None})
        if kind == 'directory':
            for child in sorted(path.iterdir()):
                visit(child)

    visit(root)
    return rows


def alter(root, change):
    if change == 'extra-runtime':
        (root / 'runtime/extra.js').write_bytes(b'extra')
    elif change == 'extra-outside':
        (root / 'outside.txt').write_bytes(b'outside')
    elif change == 'empty-dir':
        (root / 'runtime/empty').mkdir()
    elif change == 'empty-trees':
        for tree in TREES:
            if tree == 'skills':
                for relative in FILES:
                    if relative.startswith('skills/') and relative not in FIXED:
                        remove(root / relative)
            else:
                remove(root / tree)
                (root / tree).mkdir()
    elif change in ('missing-fixed', 'fixed-directory', 'fixed-link', 'dangling-link', 'tamper', 'mode'):
        path = root / 'scripts/job-apply-store.py'
        if change == 'tamper':
            path.write_bytes(b'tampered')
        elif change == 'mode':
            path.chmod(0o600)
        else:
            path.unlink()
            if change == 'fixed-directory':
                path.mkdir()
            elif change == 'fixed-link':
                path.symlink_to('job-apply-task.py')
            elif change == 'dangling-link':
                path.symlink_to('absent')
    elif change in ('missing-tree', 'tree-file'):
        remove(root / 'runtime')
        if change == 'tree-file':
            (root / 'runtime').write_bytes(b'not-directory')
    elif change == 'ancestor-file':
        remove(root / 'skills/answer-memory')
        (root / 'skills/answer-memory').write_bytes(b'not-directory')
    elif change in ('ancestor-link', 'dangling-ancestor'):
        remove(root / 'scripts')
        (root / 'scripts').symlink_to('../source/scripts' if change == 'ancestor-link' else '../absent', target_is_directory=True)
    elif change == 'nested-directory-link':
        (root / 'runtime/nested/linked').symlink_to('../../workspace', target_is_directory=True)
    elif change == 'nested-file-link':
        (root / 'runtime/nested/linked.js').symlink_to('codec.js')
    elif change == 'nested-fifo':
        os.mkfifo(root / 'runtime/nested/pipe')
    elif change == 'missing-nested':
        (root / 'runtime/nested/codec.js').unlink()
    else:
        raise AssertionError(change)
