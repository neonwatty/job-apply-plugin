"""Synthetic-root Python oracle for legacy report import parity."""
import importlib.util
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('legacy_reference_store', ROOT / 'scripts/job-apply-store.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.load(sys.stdin)
store = module.Store(Path(request['root']))
with patch.object(Path, 'home', return_value=Path(request['home'])), patch.object(module, 'utc_now', return_value=request['now']):
    try:
        if request['op'] == 'preview':
            result = store.preview_legacy_jobs(request['selected'])
        elif request['op'] == 'commit':
            result = store.commit_legacy_jobs(request['selected'], request['token'])
        else:
            raise ValueError('unsupported synthetic oracle operation')
        print(json.dumps({'value': result}, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=True))
