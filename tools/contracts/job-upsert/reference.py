"""Independent Python upsert oracle for synthetic native fixture comparisons."""
import importlib.util
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path('scripts').resolve()))
spec = importlib.util.spec_from_file_location('upsert_reference', 'scripts/job-apply-store.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.utc_now = lambda: '2026-09-10T14:00:00Z'
store = module.Store(Path(sys.argv[1]))
store.initialize()
results = []
for operation in json.loads(sys.argv[2]):
    try:
        payload = json.loads(operation['payloadJson']) if 'payloadJson' in operation else operation['payload']
        origin = operation.get('origin', 'human')
        preview = store.preview_job_upsert(payload, origin)
        result = {'preview': preview}
        commit_payload = operation.get('commitPayload', payload)
        commit_origin = operation.get('commitOrigin', origin)
        token = operation.get('token', preview['token'])
        try:
            result['commit'] = store.commit_job_upsert(commit_payload, commit_origin, token)
        except module.StoreError as error:
            result['error'] = str(error)
    except module.StoreError as error:
        result = {'error': str(error)}
    result['document'] = store.jobs_path.read_text()
    results.append(result)
print(json.dumps(results))
