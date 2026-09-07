"""Actual coordinator append and pending-tail methods on fixed synthetic files."""
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from job_apply_store.domains.coordinator import persistence
from job_apply_store import io
from support import Operations, InjectedFailure, outcome, snapshot

APPEND = {
    "normal": ([], ""), "new-file": ([], ""), "missing-parent": ([], ""),
    "symlink": ([], ""), "broken-symlink": ([], ""), "directory": ([], ""),
    "gate-hit": ([], ""), "gate-error": (["gate"], ""),
    "unicode": ([], ""), "numbers": ([], ""), "surrogate": ([], ""),
    "cycle": ([], ""), "integer-limit": ([], ""),
    "open-error": (["open"], ""), "fstat-error": (["fstat"], ""),
    "short-writes": ([], "short"), "write-error": (["write"], ""),
    "partial-error": ([], "partial-error"), "zero-write": ([], "zero"),
    "negative-write": ([], "negative"), "partial-zero": ([], "partial-zero"),
    "baseexception": ([], "baseexception"), "fsync-error": (["fsync"], ""),
    "rollback-truncate-error": (["truncate"], "partial-error"),
    "rollback-sync-error": (["rollback-fsync"], "partial-error"),
    "write-close-error": (["close"], "partial-error"),
    "truncate-close-error": (["truncate", "close"], "partial-error"),
    "close-error": (["close"], ""), "chmod-error": (["chmod"], ""),
}
REPAIR = {
    "idle": ([], ""), "missing": ([], ""), "empty": ([], ""),
    "complete": ([], ""), "partial": ([], ""), "line-less": ([], ""),
    "short-read": ([], "short-read"), "open-error": (["open"], ""),
    "fstat-error": (["fstat"], ""), "read-error": (["read"], ""),
    "truncate-error": (["truncate"], ""), "fsync-error": (["fsync"], ""),
    "close-error": (["close"], ""), "read-close-error": (["read", "close"], ""),
}
OLD = b'{"old": true}\n'


def payload(identifier):
    if identifier == "unicode":
        return {"😀": "astral", "\ue000": "private", "a": "λ\n"}
    if identifier == "numbers":
        return {"big": 2 ** 80, "float": 1.0, "nan": float("nan"), "negativeZero": -0.0}
    if identifier == "surrogate":
        return {"a": "\ud800"}
    if identifier == "integer-limit":
        return {"a": 10 ** 4300}
    if identifier == "cycle":
        result = {}
        result["a"] = result
        return result
    return {"z": 1, "a": "λ"}


def capture_case(operation, identifier, faults, behavior):
    with tempfile.TemporaryDirectory(prefix="jsonl-reference-") as temporary:
        root = Path(temporary)
        path = root / "history.jsonl"
        if operation == "append" and identifier == "missing-parent":
            path = root / "absent" / "history.jsonl"
        elif identifier in {"symlink", "broken-symlink"}:
            if identifier == "symlink":
                (root / "target.jsonl").write_bytes(OLD)
                (root / "target.jsonl").chmod(0o644)
            path.symlink_to("target.jsonl")
        elif identifier == "directory":
            path.mkdir()
        elif identifier not in {"new-file", "missing"}:
            data = OLD
            if operation == "repair":
                data = b"" if identifier == "empty" else OLD if identifier == "complete" else b"partial" if identifier == "line-less" else OLD + b'{"partial":'
            path.write_bytes(data)
            path.chmod(0o644)
        for item in [root, *root.iterdir()]:
            os.utime(item, ns=(1600000000000000000, 1600000000000000000), follow_symlinks=False)
        operations = Operations(path, faults, behavior, operation)
        instance = SimpleNamespace(history_path=path)
        fixture_event = payload(identifier) if operation == "append" else None

        def gate(event):
            assert event is fixture_event, "gate must receive the exact fixture event"
            operations.event("gate")
            return identifier == "gate-hit"

        def journal():
            operations.event("journal")
            return {"operation": None if identifier == "idle" else {"synthetic": True}}

        instance._history_event_is_idempotent_locked = gate
        instance._load_coordinator_journal = journal
        previous = persistence._RUNTIME_PROVIDER
        persistence._bind_runtime(lambda: {
            "os": operations, "json": json,
            "_set_private_mode": lambda candidate, mode: io._set_private_mode(candidate, mode, _runtime={"os": operations}),
        })
        before = snapshot(root)
        error = None
        try:
            try:
                if operation == "append":
                    persistence.CoordinatorPersistenceMixin._append_history_event_idempotent_locked(instance, fixture_event)
                else:
                    persistence.CoordinatorPersistenceMixin._repair_pending_history_tail_locked(instance)
            except BaseException as caught:
                error = caught
            return {"id": operation + ":" + identifier, "operation": operation,
                    "faults": faults, "behavior": behavior, "outcome": outcome(error),
                    "calls": operations.calls, "openDescriptorsAtReturn": len(operations.descriptors),
                    "before": before, "after": snapshot(root)}
        finally:
            persistence._bind_runtime(previous)
            operations.cleanup()


def capture():
    sources = ["scripts/job_apply_store/domains/coordinator/persistence.py", "scripts/job_apply_store/io.py",
               "scripts/job_apply_store/errors.py"]
    return {"schemaVersion": 1,
            "profile": {"python": platform.python_version(), "implementation": platform.python_implementation(),
                        "platform": sys.platform, "osName": os.name, "intMaxStrDigits": sys.get_int_max_str_digits()},
            "sources": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources},
            "cases": [capture_case(operation, name, faults, behavior)
                      for operation, cases in [("append", APPEND), ("repair", REPAIR)]
                      for name, (faults, behavior) in cases.items()]}


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("jsonl_reference_input_rejected\n")
        sys.exit(2)
    if os.name != "posix":
        sys.stderr.write("jsonl_reference_posix_required\n")
        sys.exit(3)
    sys.set_int_max_str_digits(4300)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
