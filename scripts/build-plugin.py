#!/usr/bin/env python3
"""Build the agent-only marketplace distribution; excludes companion runtime."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def build(destination: Path) -> None:
    destination = destination.resolve()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('plugin destination must be empty')
    destination.mkdir(parents=True, exist_ok=True)
    paths = subprocess.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                           cwd=ROOT, capture_output=True, check=True).stdout.decode().split('\0')
    allowed = {'scripts', 'skills', 'native', 'qa', '.codex-plugin', '.claude-plugin', '.agents'}
    for name in sorted(set(paths)):
        relative = Path(name)
        if not name or relative.parts[0] not in allowed or not (ROOT / relative).is_file():
            continue
        if any(part in {'__pycache__', 'runs', 'node_modules'} for part in relative.parts):
            continue
        if relative.suffix in {'.pyc', '.pyo'}:
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, target)
    for name in ('LICENSE',):
        if (ROOT / name).is_file():
            shutil.copy2(ROOT / name, destination / name)
    (destination / 'README.md').write_text(
        '# Job Apply agent plugin\n\n'
        'Use the bundled Job Apply skills and canonical Store CLI. The optional UI '
        'is installed separately; see the '
        '[source installation guide](https://github.com/neonwatty/job-apply-plugin).\n',
        encoding='utf-8',
    )
    for name in ('.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'):
        path = destination / name
        data = json.loads(path.read_text())
        data['plugins'][0]['source'] = {'source': 'local', 'path': './'} if name.startswith('.agents') else './'
        path.write_text(json.dumps(data, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/plugin')
    build(parser.parse_args().output)
