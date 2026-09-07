"""Frozen actual history reader/validation/identity on owned synthetic files."""
import hashlib
import io as stdio
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
from job_apply_store.domains.sessions import history
from job_apply_store.domains.coordinator import persistence
from job_apply_store.validation import sessions
from job_apply_store import normalization, io
from support import event, wire, line, snapshot, error_receipt, reader_cases, validation_cases, identity_cases


def capture_case(kind, identifier, incoming=None, data=None):
    with tempfile.TemporaryDirectory(prefix="history-identity-reference-") as temporary:
        root = Path(temporary)
        path = root / "history.jsonl"
        if isinstance(data, bytes):
            path.write_bytes(data)
            path.chmod(0o640)
        elif data == "directory":
            path.mkdir()
        elif data in {"symlink", "broken-symlink"}:
            if data == "symlink":
                (root / "target.jsonl").write_bytes(line(event()))
            path.symlink_to("target.jsonl")
        calls = []
        instance = SimpleNamespace(history_path=path)

        def read():
            calls.append({"stage": "read-history"})
            return history.SessionHistoryMixin.read_history(instance)

        def loads(text):
            calls.append({"stage": "loads", "text": text})
            return json.loads(text)

        def require(value, label):
            calls.append({"stage": "object", "label": label})
            return io.require_object(value, label)

        def version(value, label):
            calls.append({"stage": "version", "label": label})
            return io.validate_version(value, label)

        def record(value):
            calls.append({"stage": "record", "value": wire(value)})
            return sessions._validate_history_event_record(value)

        def validate(value):
            assert value is incoming, "idempotency must validate exact incoming event"
            calls.append({"stage": "write-validation", "value": wire(value)})
            return sessions._validate_history_event_for_write(value)

        def canonical(value):
            result = normalization._canonical_json(value)
            calls.append({"stage": "canonical", "value": wire(value), "result": result, "resultCodepoints": list(map(ord, result))})
            return result

        instance.read_history = read
        old_history, old_persistence = history._RUNTIME_PROVIDER, persistence._RUNTIME_PROVIDER
        history._bind_runtime(lambda: {"json": SimpleNamespace(loads=loads, JSONDecodeError=json.JSONDecodeError),
                                      "_require_object": require, "validate_version": version,
                                      "_validate_history_event_record": record})
        persistence._bind_runtime(lambda: {"_validate_history_event_for_write": validate,
                                          "_canonical_json": canonical})
        before = snapshot(root)
        incoming_before = wire(incoming)
        try:
            result, error = None, None
            try:
                if kind == "reader":
                    result = read()
                elif kind == "identity":
                    result = persistence.CoordinatorPersistenceMixin._history_event_is_idempotent_locked(instance, incoming)
                elif kind == "record":
                    result = sessions._validate_history_event_record(incoming)
                else:
                    result = sessions._validate_history_event_for_write(incoming)
            except BaseException as caught:
                error = caught
            return {"id": kind + ":" + identifier, "incoming": incoming_before,
                    "incomingAfter": wire(incoming),
                    "incomingRoleCodepoints": list(map(ord, incoming["role"])) if isinstance(incoming, dict) and isinstance(incoming.get("role"), str) else None, "inputHex": data.hex() if isinstance(data, bytes) else None,
                    "fixture": data if isinstance(data, str) else "file" if isinstance(data, bytes) else "missing",
                    "value": wire(result) if error is None else None, "error": error_receipt(error, root),
                    "calls": calls, "before": before, "after": snapshot(root)}
        finally:
            history._bind_runtime(old_history)
            persistence._bind_runtime(old_persistence)


def canonical_cases():
    values = {"nonascii": {"\U0001f600": "\u03bb", "\ue000": "x"},
              "surrogate": {"role": "\ud800"}, "numbers": [1, 1.0, -0.0, 2 ** 80, float("nan"), float("inf")],
              "whitespace": {"x": "a\n  b\t"}, "ordered": {"z": [], "a": {}}, "integer-limit": 10 ** 4300}
    cycle = []; cycle.append(cycle); values["cycle"] = cycle
    rows = []
    for name, value in values.items():
        result, error = None, None
        try:
            result = normalization._canonical_json(value)
        except BaseException as caught:
            error = caught
        rows.append({"id": "canonical:" + name, "value": result,
                     "error": error_receipt(error, ROOT),
                     "codepoints": list(map(ord, result)) if result is not None else None})
    return rows


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def capture():
    sources = ["scripts/job_apply_store/domains/sessions/history.py",
               "scripts/job_apply_store/domains/coordinator/persistence.py",
               "scripts/job_apply_store/validation/sessions.py", "scripts/job_apply_store/normalization.py",
               "scripts/job_apply_store/constants.py", "scripts/job_apply_store/io.py", "scripts/job_apply_store/errors.py"]
    modules = {"json": json, "json.encoder": json.encoder, "json.decoder": json.decoder,
               "json.scanner": json.scanner, "io": stdio}
    modules.update({name: module for name, module in sys.modules.items()
                    if name == "pathlib" or name.startswith("pathlib.")})
    stdlib = {name: {"path": str(Path(module.__file__).resolve()), "sha256": file_hash(module.__file__)}
              for name, module in modules.items()}
    native_modules = {}
    for name in ["_io", "_json"]:
        module = sys.modules[name]
        origin = module.__spec__.origin
        native_modules[name] = {"origin": origin,
                                "sha256": file_hash(origin) if origin != "built-in" else None}
    rows = [capture_case("reader", name, data=data) for name, data in reader_cases().items()]
    rows += [capture_case(kind, name, incoming=value) for kind in ["record", "write"]
             for name, value in validation_cases().items()]
    rows += [capture_case("identity", name, incoming=value, data=data)
             for name, (value, data) in identity_cases().items()]
    return {"schemaVersion": 1, "profile": {"python": platform.python_version(),
            "implementation": platform.python_implementation(), "platform": sys.platform, "osName": os.name,
            "intMaxStrDigits": sys.get_int_max_str_digits(), "hashSeedEnvironment": os.environ.get("PYTHONHASHSEED"),
            "ignoreEnvironment": sys.flags.ignore_environment, "hashRandomization": sys.flags.hash_randomization,
            "executablePath": str(Path(sys.executable).resolve()),
            "executableSha256": file_hash(sys.executable), "byteOrder": sys.byteorder},
            "sources": {name: file_hash(ROOT / name) for name in sources}, "stdlib": stdlib,
            "nativeModules": native_modules, "cases": rows, "canonical": canonical_cases()}


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("history_identity_reference_input_rejected\n")
        sys.exit(2)
    if os.name != "posix":
        sys.stderr.write("history_identity_reference_posix_required\n")
        sys.exit(3)
    sys.set_int_max_str_digits(4300)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
