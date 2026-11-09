"""Read-only observation of a caller-owned synthetic fixture, without Store startup."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
from job_apply_store.constants import RESUME_MAX_BYTES, OVERVIEW_DIGEST_CACHE_SECONDS
from job_apply_store.domains.resumes import storage
from job_apply_store.normalization import _managed_resume_digest_cache_identity, _resume_modified_at


def capture(request):
    root = Path(request['root'])
    now = datetime(2026, 1, 2, tzinfo=timezone.utc)
    instance = SimpleNamespace(resume_files_path=root, _now_datetime=lambda: now,
                               _private_file_digest=storage.ResumeStorageMixin._private_file_digest)
    instance._managed_resume_path = lambda record: storage.ResumeStorageMixin._managed_resume_path(instance, record)
    previous = storage._RUNTIME_PROVIDER
    storage._bind_runtime(lambda: {
        'os': os, 'stat': stat, 'hashlib': hashlib, 'timedelta': timedelta,
        'RESUME_MAX_BYTES': RESUME_MAX_BYTES,
        'OVERVIEW_DIGEST_CACHE_SECONDS': OVERVIEW_DIGEST_CACHE_SECONDS,
        '_resume_modified_at': _resume_modified_at,
        '_managed_resume_digest_cache_identity': _managed_resume_digest_cache_identity,
    })
    cache = {}
    outcomes = []
    try:
        for _ in range(2):
            try:
                value = storage.ResumeStorageMixin._managed_resume_observation(instance, request['record'], digest_cache=cache)
                outcomes.append({'kind': 'value', 'value': value})
            except Exception as error:
                outcome = {'kind': 'error', 'name': type(error).__name__}
                if outcome['name'] == 'StoreError':
                    outcome['message'] = str(error)
                outcomes.append(outcome)
        return {'outcomes': outcomes, 'cache': {key: {
            'digest': value['digest'], 'checkedAt': value['checkedAt'].isoformat(),
            'identityMatchesFile': value['identity'] == _managed_resume_digest_cache_identity(
                (root / request['record']['managedFile']).lstat()),
        } for key, value in cache.items()}}
    finally:
        storage._bind_runtime(previous)


if __name__ == '__main__':
    print(json.dumps(capture(json.load(sys.stdin)), ensure_ascii=True))
