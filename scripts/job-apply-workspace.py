#!/usr/bin/env python3
"""Discover the optional, independently installed Job Apply Companion."""
import os
from pathlib import Path
import sys


def main() -> int:
    prefix = Path(os.environ.get('JOB_APPLY_COMPANION_HOME', '~/.local/share/job-apply-companion')).expanduser()
    launcher = prefix / 'companion.py'
    if not launcher.is_file():
        print('The optional companion is not installed. From a Job Apply source checkout, run '
              'python3 companion/install.py. The agent and Store CLI work without it.', file=sys.stderr)
        return 2
    os.execv(sys.executable, [sys.executable, str(launcher), *sys.argv[1:]])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
