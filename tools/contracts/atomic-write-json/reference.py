"""Fixed atomic-write reference on disposable files; accepts no caller inputs."""
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from job_apply_store import io
from support import Operations, outcome, snapshot

CASES = [
    "basic", "missing-parent", "numbers", "unicode", "surrogate", "unsupported", "cycle",
    "symlink", "broken-symlink", "directory", "mkdir", "parent-chmod", "temp-create",
    "partial-write", "flush", "file-fsync", "temp-close", "temp-chmod", "replace",
    "destination-chmod", "directory-open", "directory-fsync", "directory-close",
    "replace-cleanup", "replace-cleanup-missing", "write-close", "write-cleanup",
    "list", "null", "mixed-keys", "integer-limit", "parent-symlink",
    "directory-open-value", "directory-fsync-value",
]

SPECIAL_PAYLOADS = {"numbers", "unicode", "surrogate", "unsupported", "cycle",
                    "list", "null", "mixed-keys", "integer-limit"}
STAGES = {"mkdir", "parent-chmod", "temp-create", "partial-write", "flush", "file-fsync",
          "temp-close", "temp-chmod", "replace", "destination-chmod", "directory-open",
          "directory-fsync", "directory-close", "directory-open-value", "directory-fsync-value"}


def payload(identifier):
    if identifier == "list":
        return [1, None, {}]
    if identifier == "null":
        return None
    if identifier == "mixed-keys":
        return {"a": 1, 2: "b"}
    if identifier == "integer-limit":
        return {"big": 10 ** 4300}
    if identifier == "numbers":
        return {"big": 10 ** 80 + 1, "float": 1.0, "negativeZero": -0.0,
                "nan": float("nan"), "infinity": float("inf"), "tiny": 5e-324}
    if identifier == "unicode":
        return {"😀": "astral", "\ue000": "private", "a": "λ\n\t\u007f", "empty": [{}, []]}
    if identifier == "surrogate":
        return {"a": "\ud800"}
    if identifier == "unsupported":
        return {"a": {1, 2}}
    if identifier == "cycle":
        result = {}
        result["a"] = result
        return result
    return {"z": 1, "emoji": "λ"}


def capture_case(identifier):
    with tempfile.TemporaryDirectory(prefix="atomic-json-reference-") as temporary:
        root = Path(temporary)
        parent = root / "private"
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)
        if identifier == "parent-symlink":
            parent.rename(root / "real")
            parent.symlink_to("real", target_is_directory=True)
        target = parent / "document.json"
        if identifier == "missing-parent":
            target = parent / "nested" / "deep" / "document.json"
        elif identifier in {"symlink", "broken-symlink"}:
            if identifier == "symlink":
                (parent / "foreign.json").write_bytes(b"foreign\n")
            target.symlink_to("foreign.json")
        elif identifier == "directory":
            target.mkdir()
        else:
            target.write_bytes(b"old\n")
            target.chmod(0o644)
        for path in [root, *root.rglob("*")]:
            os.utime(path, ns=(1600000000000000000, 1600000000000000000), follow_symlinks=False)
        faults = {
            "replace-cleanup": ["replace", "cleanup"],
            "replace-cleanup-missing": ["replace", "cleanup-missing"],
            "write-close": ["partial-write", "temp-close"],
            "write-cleanup": ["partial-write", "cleanup"],
        }.get(identifier, [identifier] if identifier in STAGES else [])
        operations = Operations(root, target, faults)
        before = snapshot(root)
        error = None
        try:
            with patch.object(io.tempfile, "NamedTemporaryFile", operations.temporary):
                io.atomic_write_json(operations.Path(target), payload(identifier),
                                     _runtime={"os": operations, "Path": operations.Path})
        except Exception as caught:
            error = caught
        after = snapshot(root, operations.temporary_path)
        return {"id": identifier, "target": str(target.relative_to(root)),
                "payload": identifier if identifier in SPECIAL_PAYLOADS else "basic",
                "faults": faults, "outcome": outcome(error), "events": operations.events, "calls": operations.calls,
                "writeCalls": operations.write_calls, "tempClosed": operations.temp_closed,
                "directoryClosed": operations.directory_closed, "before": before, "after": after}


def capture():
    source = ROOT / "scripts/job_apply_store/io.py"
    return {"schemaVersion": 1,
            "profile": {"python": platform.python_version(), "implementation": platform.python_implementation(),
                        "platform": sys.platform, "osName": os.name,
                        "intMaxStrDigits": sys.get_int_max_str_digits()},
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "cases": [capture_case(identifier) for identifier in CASES]}


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("atomic_write_json_reference_input_rejected\n")
        sys.exit(2)
    if os.name != "posix":
        sys.stderr.write("atomic_write_json_reference_posix_required\n")
        sys.exit(3)
    sys.set_int_max_str_digits(4300)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
