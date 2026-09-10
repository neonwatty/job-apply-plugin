"""Run the original reviewed-restart gates with real disk IO and projection.

Only coordinator setup and post-evidence acquisition are replaced: reaching
preflight proves all original evidence gates completed, before any claim write.
"""
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
from job_apply_store.domains.coordinator import claims
from job_apply_store.sessions_runtime import _project_legacy_session

claims._bind_runtime(lambda: {**vars(claims), '_project_legacy_session': _project_legacy_session})

class EvidenceAccepted(Exception):
    pass

class Fixture(claims.CoordinatorClaimsMixin):
    def __init__(self, root, item):
        self.item = item
        self.store_lock_path = root / 'store.lock'
        self.path = root / 'session.json'
        if item['session'] is not None:
            self.path.write_text(json.dumps(item['session']), encoding='utf-8')
    def initialize(self):
        pass
    def _ensure_coordinator_files(self):
        pass
    def _load_coordinator_document(self):
        return {'schemaVersion': 1, 'claim': None}
    def _load_jobs_document(self):
        return {'jobs': {self.item['job']['id']: self.item['job']}}
    def _session_path(self, job_id):
        return self.path
    def read_history(self):
        return self.item['history']
    def _preflight_job_record(self, job):
        raise EvidenceAccepted()

rows = []
for item in json.load(sys.stdin):
    with TemporaryDirectory() as directory:
        fixture = Fixture(Path(directory), item)
        try:
            fixture.restart_reviewed_job(item['job']['id'], 'Fixture', item['job']['revision'], True)
        except EvidenceAccepted:
            modern = {'attemptRevision', 'readiness', 'browserHandoff'} & set(item['session'])
            rows.append({'value': 'job-restarted' if modern else 'legacy-review-rebuild'})
        except Exception as error:
            rows.append({'error': str(error)})
print(json.dumps(rows, ensure_ascii=True))
