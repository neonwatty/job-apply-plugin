"""Deterministic, synthetic Python policy oracle; never reads the owner's Store."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('policy_reference', ROOT / 'scripts/job_apply_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def snapshot(root):
    entries = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        entries[relative] = {'mode': path.stat().st_mode & 0o777}
        if path.is_file():
            entries[relative]['bytes'] = path.read_text()
    encoded = json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()
    return {'entries': entries, 'digest': hashlib.sha256(encoded).hexdigest()}


def run(request):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        store = policy.PolicyStore(root)
        ordinal = 0

        def new_reference(kind):
            nonlocal ordinal
            ordinal += 1
            return f'{kind}:{ordinal:064x}'

        for module in (policy._model, policy._storage, policy._campaigns,
                       policy._authorization_module, policy._outcomes):
            module._new_reference = new_reference
        result = []
        for case in request['cases']:
            try:
                op, value = case['op'], case.get('value')
                validators = {'rule': policy._rule, 'sensitive': policy._sensitive,
                              'authorization': policy._authorization,
                              'campaign': store._validate_campaign,
                              'application': store._validate_application,
                              'receipt': policy._validate_receipt,
                              'digest': policy._digest,
                              'time': lambda item: policy.parse_time(item).timestamp() * 1000,
                              'authority': policy.confirmation_authority_revision}
                if op in validators:
                    output = validators[op](value)
                elif op == 'confirmation':
                    output = policy._confirmation_event(value, case['claimId'], case['authority'], case['capability'])
                elif op == 'write':
                    path = root / case['path']
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(value)
                    output = None
                elif op == 'remove':
                    (root / case['path']).unlink()
                    output = None
                else:
                    now = policy.parse_time(case['now'])
                    if op == 'status':
                        output = store.decision(now=now)
                    elif op in ('activate', 'authorize'):
                        output = getattr(store, op)(value, now=now)
                    elif op in ('kill', 'revoke'):
                        output = getattr(store, op)(now=now)
                    elif op == 'claim':
                        output = store.claim_final_action(**value, now=now)
                    elif op == 'outcome':
                        output = store.record_outcome(**value, now=now)
                    else:
                        raise ValueError('unknown synthetic operation')
                result.append({'ok': output})
            except (policy.PolicyError, ValueError, TypeError) as error:
                result.append({'error': str(error)})
        return {'results': result, 'tree': snapshot(root)}


if __name__ == '__main__':
    os.umask(0o022)
    print(json.dumps(run(json.load(sys.stdin)), sort_keys=True))
