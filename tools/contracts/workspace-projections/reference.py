"""Execute authoritative Python projections against synthetic in-memory documents."""
import contextlib
import importlib.util
import json
from pathlib import Path
import sys
from datetime import datetime
from types import SimpleNamespace

repo = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("projection_contract_store", repo / "scripts/job-apply-store.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.exclusive_file_lock = lambda *_: contextlib.nullcontext()
state = json.load(sys.stdin)
store = module.Store.__new__(module.Store)
store.initialize = lambda: None
store._ensure_coordinator_files = lambda: None
store.store_lock_path = Path('/synthetic/unused-lock')
store._overview_resume_digest_cache = {}
for name in ('jobs', 'profile', 'resumes', 'answers', 'coordinator'):
    setattr(store, f'_load_{name}_document', lambda name=name: state[name])
store._now_datetime = lambda: datetime.fromisoformat(state['now'].replace('Z', '+00:00'))
sessions = {item['applicationId']: item for item in state['sessions']}
store._session_path = lambda identity: SimpleNamespace(exists=lambda: identity in sessions)
store._read_session_projection = lambda path, identity, ats=None: sessions[identity]
store.read_history = lambda: state['history']
# File observations have their own native contract; these fixtures carry no ready jobs.
result = {
    'overview': store.owner_beta_overview(),
    'attention': store.list_needs_attention(),
    'snapshot': store.task_snapshot(),
    'activity': {identity: store.get_job_activity(identity) for identity, job in state['jobs']['jobs'].items() if job.get('deletedAt') is None},
}
print(json.dumps(result, ensure_ascii=False))
