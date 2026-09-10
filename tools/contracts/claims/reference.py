"""Pure claim reference against original Python validators and mixin."""
import hashlib
import json
from pathlib import Path
import sys
from datetime import timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
from job_apply_store.validation.sessions import _parse_coordinator_time, _validate_claim_record
from job_apply_store.io import validate_version
from job_apply_store.errors import StoreError
from job_apply_store.domains.coordinator.claims import CoordinatorClaimsMixin

class Fixture(CoordinatorClaimsMixin):
    def __init__(self, item):
        self.item = item
        self.coordinator_path = self
    def exists(self):
        return True
    def _load_coordinator_document(self):
        return self.item['coordinator']
    def _load_jobs_document(self):
        return self.item['jobs']
    def _now_datetime(self):
        return _parse_coordinator_time(self.item['now'])

def invoke(item):
    operation = item['op']
    if operation == 'time':
        parsed = _parse_coordinator_time(item['value'])
        from datetime import datetime
        delta = parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)
        return str((delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds)
    if operation == 'validate':
        document = item['coordinator']
        validate_version(document, 'coordinator')
        if set(document) != {'schemaVersion', 'claim'}:
            raise StoreError('coordinator contains unsupported fields')
        if document['claim'] is not None:
            _validate_claim_record(document['claim'])
        return document
    if operation == 'hash':
        return CoordinatorClaimsMixin._token_hash(item['token'])
    fixture = Fixture(item)
    if operation == 'require':
        return fixture._require_claim_locked(item['jobId'], item['token'], item.get('allowExpired', False))
    if operation == 'unclaimed':
        return fixture._require_job_unclaimed_locked(item['jobId'])
    if operation == 'public':
        return fixture._public_claim(item['coordinator']['claim'])
    raise ValueError('unknown operation')

rows = []
for item in json.load(sys.stdin):
    try:
        rows.append({'value': invoke(item)})
    except Exception as error:
        # Unicode encoder wording is implementation-specific; preserve category.
        rows.append({'error': 'UnicodeEncodeError' if isinstance(error, UnicodeEncodeError) else str(error)})
print(json.dumps(rows, ensure_ascii=True))
