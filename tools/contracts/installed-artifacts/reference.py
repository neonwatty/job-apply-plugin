"""Actual artifact functions on fixed owned trees; no caller paths or Store."""
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


support = module('synthetic_artifact_support', HERE / 'support.py')
artifacts = module('actual_artifacts', ROOT / 'scripts/smoke/artifacts.py')
CASES = [
    ('inventory-normal', 'inventory', None),
    ('inventory-extra-runtime', 'inventory', 'extra-runtime'),
    ('inventory-extra-outside', 'inventory', 'extra-outside'),
    ('inventory-empty-trees', 'inventory', 'empty-trees'),
    ('inventory-missing-fixed', 'inventory', 'missing-fixed'),
    ('inventory-missing-tree', 'inventory', 'missing-tree'),
    ('inventory-fixed-directory', 'inventory', 'fixed-directory'),
    ('inventory-tree-file', 'inventory', 'tree-file'),
    ('inventory-ancestor-file', 'inventory', 'ancestor-file'),
    ('inventory-fixed-link', 'inventory', 'fixed-link'),
    ('inventory-ancestor-link', 'inventory', 'ancestor-link'),
    ('inventory-nested-directory-link', 'inventory', 'nested-directory-link'),
    ('inventory-nested-file-link', 'inventory', 'nested-file-link'),
    ('inventory-dangling-link', 'inventory', 'dangling-link'),
    ('inventory-root-link', 'inventory', None),
    ('inventory-nested-fifo', 'inventory', 'nested-fifo'),
    ('verify-normal', 'verify', None),
    ('verify-tamper', 'verify', 'tamper'),
    ('verify-extra-runtime', 'verify', 'extra-runtime'),
    ('verify-extra-outside', 'verify', 'extra-outside'),
    ('verify-mode', 'verify', 'mode'),
    ('verify-empty-dir', 'verify', 'empty-dir'),
    ('verify-missing-fixed', 'verify', 'missing-fixed'),
    ('verify-missing-nested', 'verify', 'missing-nested'),
    ('copy-empty', 'copy', None),
    ('copy-empty-trees', 'copy', 'source-empty-trees'),
    ('copy-overwrite', 'copy', 'tamper'),
    ('copy-extra-retained', 'copy', 'extra-runtime'),
    ('copy-directory-rejected', 'copy', 'fixed-directory'),
    ('copy-link-rejected', 'copy', 'fixed-link'),
    ('copy-ancestor-rejected', 'copy', 'ancestor-link'),
    ('copy-dangling-ancestor', 'copy', 'dangling-ancestor'),
    ('copy-source-invalid', 'copy', 'source-invalid'),
]


def capture_case(identifier, operation, change):
    with tempfile.TemporaryDirectory(prefix='artifact-reference-') as temporary:
        root = Path(temporary)
        source = support.fixture(root / 'source')
        target = root / 'target'
        if identifier in ('copy-empty', 'copy-empty-trees'):
            target.mkdir()
        else:
            support.fixture(target)
        if change == 'source-invalid':
            support.alter(source, 'missing-fixed')
        elif change == 'source-empty-trees':
            support.alter(source, 'empty-trees')
        elif change:
            support.alter(target, change)
        if identifier in ('copy-directory-rejected', 'copy-link-rejected',
                          'copy-ancestor-rejected', 'copy-dangling-ancestor', 'copy-source-invalid'):
            # The first inventory file differs: an early copy cannot hide behind
            # copying already-identical bytes before a later rejection.
            (target / '.codex-plugin/plugin.json').write_bytes(b'unchanged target sentinel')
        selected = target
        if identifier == 'inventory-root-link':
            selected = root / 'alias'
            selected.symlink_to('target', target_is_directory=True)
        before = support.snapshot(root)
        try:
            if operation == 'inventory':
                result = list(artifacts.critical_paths(selected))
            elif operation == 'verify':
                result = artifacts.assert_critical_bytes(target, source, label='synthetic')
            else:
                result = artifacts.copy_critical(source, target)
            outcome = {'kind': 'value', 'value': result}
        except SystemExit as error:
            outcome = {'kind': 'error', 'name': 'SystemExit', 'message': str(error)}
        after = support.snapshot(root)
        return {'id': identifier, 'operation': operation, 'change': change,
                'outcome': outcome, 'before': before, 'after': after}


def capture():
    source = ROOT / 'scripts/smoke/artifacts.py'
    return {'schemaVersion': 1, 'profile': {
        'implementation': platform.python_implementation(),
        'python': platform.python_version(), 'platform': sys.platform},
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'fixedFiles': list(artifacts.FIXED_CRITICAL_FILES),
        'criticalTrees': list(artifacts.CRITICAL_TREES),
        'cases': [capture_case(*case) for case in CASES]}


if __name__ == '__main__':
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write('installed_artifacts_reference_input_rejected\n')
        sys.exit(2)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
