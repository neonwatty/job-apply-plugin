#!/usr/bin/env python3
"""Stable companion entry point. Foreground launch; Ctrl-C stops the server."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys


def selected(prefix: Path) -> tuple[Path, dict]:
    release = json.loads((prefix / 'current.json').read_text())['release']
    if not isinstance(release, str) or Path(release).name != release or release in ('.', '..'):
        raise ValueError('invalid companion release selection')
    bundle = prefix / 'versions' / release
    receipt = json.loads((bundle / 'bundle.json').read_text())
    if receipt.get('coreApi') != 1 or receipt.get('storeSchema') != 1:
        raise ValueError('unsupported companion/core contract; install a compatible companion')
    core = json.loads((bundle / 'scripts/job_apply_core_contract.json').read_text())
    if core != {'coreApi': receipt['coreApi'], 'storeSchema': receipt['storeSchema']}:
        raise ValueError('companion and canonical core contracts are incompatible')
    # Check the complete runtime before Store imports or initialization.
    for name, expected in receipt['files'].items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('invalid companion bundle inventory')
        if hashlib.sha256((bundle / relative).read_bytes()).hexdigest() != expected:
            raise ValueError('companion bundle is damaged; reinstall into a fresh prefix')
    return bundle, receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--status', action='store_true', help='show selected installation without opening the Store')
    parser.add_argument('--root', help='explicit canonical Store root')
    args, remaining = parser.parse_known_args()
    prefix = Path(__file__).resolve().parent
    try:
        bundle, receipt = selected(prefix)
    except (OSError, ValueError, KeyError, TypeError):
        print('Companion installation is missing, damaged, or incompatible. Reinstall the companion.', file=sys.stderr)
        return 2
    root = str(Path(args.root or os.environ.get('JOB_APPLY_STORE_DIR', '~/.job-apply')).expanduser().resolve())
    if args.status:
        print(json.dumps({'version': receipt['version'], 'release': receipt['release'],
                          'storeRoot': root, 'installation': str(bundle),
                          'status': 'installed', 'coreApi': receipt['coreApi']}))
        return 0
    command = [sys.executable, str(bundle / 'scripts/job-apply-workspace.py'), '--root', root, *remaining]
    os.execv(sys.executable, command)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
