"""Synthetic build-session differential oracle; stdin contains test-owned documents."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("claim_session_store", ROOT / "scripts/job-apply-store.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Oracle(module.Store):
    def __init__(self, item):
        self.item = copy.deepcopy(item)

    def _session_path(self, identity):
        return SimpleNamespace(exists=lambda: self.item["context"]["existing"] is not None)

    def _read_session_projection(self, *args):
        return self.item["context"]["existing"]

    def _load_answers_document(self):
        return self.item["context"]["answers"]


def handoff(session, incoming, target, attempt):
    # Exercise the production handoff method through fake locked persistence.
    class HandoffOracle(Oracle):
        def initialize(self): pass
        def _ensure_coordinator_files(self): pass
        def _require_claim_locked(self, *args): pass
        def _load_jobs_document(self):
            return {"jobs": {"job": {"id": "job", "revision": attempt, "status": "in_progress", "ats": "greenhouse"}}}
        def _now(self): return "now"
        def _build_session(self, *args, **kwargs): return session
        def _history_event_for_operation(self, *args): return {}
        def _commit_coordinator_operation_locked(self, operation): pass
        def _session_summary(self, *args): return {}
    import contextlib
    original = module.exclusive_file_lock
    module.exclusive_file_lock = lambda *args: contextlib.nullcontext()
    try:
        instance = HandoffOracle({"context": {"existing": None, "answers": {}}})
        instance.store_lock_path = None
        # The return projection is irrelevant; isolate validation by terminating
        # at the first commit, after all production handoff checks.
        class Committed(Exception): pass
        def committed(*args): raise Committed()
        instance._commit_coordinator_operation_locked = committed
        try:
            instance.handoff_claimed_job("job", "synthetic-token", target, incoming, attempt)
        except Committed:
            return
    finally:
        module.exclusive_file_lock = original


result = []
for item in json.load(sys.stdin):
    try:
        context = item["context"]
        session = Oracle(item)._build_session(
            "job", item["incoming"], context["now"],
            expected_attempt_revision=context["attemptRevision"], expected_ats=context["ats"],
        )
        if "target" in item:
            handoff(session, item["incoming"], item["target"], context["attemptRevision"])
        result.append({"session": session})
    except Exception as error:
        result.append({"error": str(error)})
print(json.dumps(result))
