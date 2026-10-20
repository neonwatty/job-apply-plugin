#!/usr/bin/env python3
"""Install an immutable, self-contained companion without touching applicant data."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def install(destination: Path) -> dict:
    version = json.loads((ROOT / 'companion/version.json').read_text())
    core = json.loads((ROOT / 'scripts/job_apply_core_contract.json').read_text())
    if core != {key: version[key] for key in ('coreApi', 'storeSchema')}:
        raise ValueError('companion and canonical core contracts are incompatible')
    destination = destination.expanduser().resolve()
    if destination == ROOT or ROOT in destination.parents:
        raise ValueError("choose a stable installation outside the source checkout")
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.install-', dir=destination) as temporary:
        stage = Path(temporary) / 'bundle'
        shutil.copytree(ROOT / 'companion', stage, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        # Both clients ship the same canonical core; there is no cache import.
        shutil.copytree(ROOT / 'scripts', stage / 'scripts', dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'job-apply-workspace.py', 'smoke'))
        if (ROOT / 'native').exists():
            shutil.copytree(ROOT / 'native', stage / 'native')
        shutil.copytree(ROOT / 'qa', stage / 'qa',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'runs'))
        (stage / 'install.py').unlink()
        files = {p.relative_to(stage).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in sorted(stage.rglob('*')) if p.is_file()}
        digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        release = version['version'] + '-' + digest[:16]
        receipt = {**version, 'release': release, 'files': files}
        (stage / 'bundle.json').write_text(json.dumps(receipt, indent=2) + '\n')
        versions = destination / 'versions'
        versions.mkdir(exist_ok=True)
        target = versions / release
        if target.exists():
            # A partial or modified prior bundle must never be selected.
            for name, expected in files.items():
                if hashlib.sha256((target / name).read_bytes()).hexdigest() != expected:
                    raise OSError('existing companion bundle is damaged; use a fresh installation directory')
            if json.loads((target / 'bundle.json').read_text()) != receipt:
                raise OSError('existing companion receipt is damaged')
        else:
            os.replace(stage, target)
        manager = Path(temporary) / 'companion.py'
        shutil.copy2(ROOT / 'companion/manage.py', manager)
        os.replace(manager, destination / 'companion.py')
        pointer = Path(temporary) / 'current.json'
        pointer.write_text(json.dumps({'release': release}) + '\n')
        os.replace(pointer, destination / 'current.json')
    return {'version': version['version'], 'release': release,
            'launcher': str(destination / 'companion.py'), 'bundle': str(target)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', type=Path, default=Path.home() / '.local/share/job-apply-companion')
    args = parser.parse_args()
    print(json.dumps(install(args.prefix)))


if __name__ == '__main__':
    main()
