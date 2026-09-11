"""Python task-intake oracle, used only with independent synthetic Store copies."""
import importlib.util
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path('scripts').resolve()))
spec = importlib.util.spec_from_file_location('intake_reference', 'scripts/job-apply-store.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.utc_now = lambda: '2026-09-10T14:00:00Z'
store = module.Store(Path(sys.argv[1]))
store.initialize()
results = []
for operation in json.loads(sys.argv[2]):
    try:
        payload = json.loads(operation['payloadJson']) if 'payloadJson' in operation else operation['payload']
        result = {'result': store.intake_task_job(payload, operation.get('origin', 'agent'))}
    except module.StoreError as error:
        result = {'error': str(error)}
    result['document'] = store.jobs_path.read_text()
    results.append(result)
print(json.dumps(results))
