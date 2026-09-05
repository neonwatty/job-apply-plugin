"""Authoritative CLI captures confined to a fresh temporary Store per scenario."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import uuid
from datetime import datetime

# Isolated Python mode omits this directory from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenarios import CANARY, SCENARIOS

REPO = Path(__file__).resolve().parents[3]
CLOCK = "2026-09-05T00:00:00Z"


def load_store():
    spec = importlib.util.spec_from_file_location("profile_fact_contract_store", REPO / "scripts/job-apply-store.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot(root):
    metadata = root.stat()
    result = {".": ("directory", metadata.st_dev, metadata.st_ino, metadata.st_mode)}
    if os.name != "nt" and metadata.st_mode & 0o777 != 0o700:
        raise RuntimeError("fixture_root_mode_invalid")
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative == ".store.lock":
            continue
        metadata = path.lstat()
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise RuntimeError("fixture_entry_invalid")
        if os.name != "nt" and metadata.st_mode & 0o777 != (0o700 if path.is_dir() else 0o600):
            raise RuntimeError("fixture_private_mode_invalid")
        if path.is_dir():
            result[relative] = ("directory", metadata.st_dev, metadata.st_ino, metadata.st_mode)
        else:
            result[relative] = ("file", path.read_bytes(), metadata.st_mtime_ns, metadata.st_mode)
    return result


def projected(entry):
    # Persist raw text, including exact newline bytes; no OS newline normalization.
    return entry[1].decode("utf-8")


def capture():
    module = load_store()
    module.utc_now = lambda: CLOCK
    counters = {"uuid": 0, "nonce": 0}

    def fixed_uuid():
        counters["uuid"] += 1
        return uuid.UUID(int=counters["uuid"])

    def fixed_nonce(*args, **kwargs):
        counters["nonce"] += 1
        return "synthetic-contract-nonce-%04d" % counters["nonce"]

    module.uuid.uuid4 = fixed_uuid
    secrets.token_urlsafe = fixed_nonce
    cases = []
    for name, setup, operation, expected_writes, expected_code in SCENARIOS:
        with tempfile.TemporaryDirectory(prefix="job-apply-profile-facts-") as temporary:
            root = Path(temporary) / "store"
            counters.update(uuid=0, nonce=0)
            module.resolve_store = lambda args: module.Store(
                root, Path(temporary) / "absent-legacy.json",
                clock=lambda: datetime.fromisoformat(CLOCK.replace("Z", "+00:00")))

            def run(command):
                args, payload = command
                sys.argv = ["job-apply-store.py", "--root", str(root), *args]
                sys.stdin = io.StringIO(json.dumps(payload))
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    try:
                        code = module.main()
                    except SystemExit as error:
                        code = error.code
                return {"exitCode": code or 0, "stdout": stdout.getvalue().replace("\r\n", "\n"),
                        "stderr": stderr.getvalue().replace("\r\n", "\n")}

            for command in [(["init"], None), *setup]:
                result = run(command)
                if result["exitCode"] != 0 or result["stderr"]:
                    raise RuntimeError("fixture_setup_failed")
            for path in root.rglob("*"):
                if path.is_file():
                    os.utime(path, ns=(1577836800000000000, 1577836800000000000))
            before = snapshot(root)
            counters.update(uuid=0, nonce=0)
            result = run(operation)
            after = snapshot(root)
            writes = sorted(key for key in before.keys() | after.keys() if before.get(key) != after.get(key))
            if writes != expected_writes or result["exitCode"] != expected_code:
                raise RuntimeError("fixture_effect_mismatch:" + name)
            if counters["nonce"] != 0 or counters["uuid"] != (1 if name == "group-create" else 0):
                raise RuntimeError("fixture_randomness_mismatch")
            surfaces = json.dumps(result) + "".join(
                value[1].decode("utf-8") for value in after.values() if value[0] == "file")
            if CANARY in surfaces or str(root) in surfaces:
                raise RuntimeError("fixture_secret_leak")
            effects = [{"path": key, "before": projected(before[key]), "after": projected(after[key]),
                        "mtimeChanged": before[key][2] != after[key][2],
                        "modeContract": "0600-on-posix-unverified-on-windows"} for key in writes]
            if any(not effect["mtimeChanged"] for effect in effects):
                raise RuntimeError("fixture_mtime_invalid")
            # Canary-bearing inputs are descriptors only; secret never enters the artifact.
            args, payload = operation
            safe_payload = json.loads(json.dumps(payload).replace(CANARY, "<secret-canary>"))
            cases.append({"scenario": name, "args": args, "input": safe_payload, **result,
                          "uuidCalls": counters["uuid"], "nonceCalls": counters["nonce"],
                          "expectedWrites": expected_writes, "observedWrites": writes,
                          "effects": effects, "untouchedEntriesUnchanged": True,
                          "rejectedStateUnchanged": result["exitCode"] != 0 and before == after})
    return {"schemaVersion": 1, "corpus": "python-profile-fact-mutations-v1", "clock": CLOCK,
            "cases": cases, "secretCanaryAbsent": True}


if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit("fixture_arguments_forbidden")
    try:
        print(json.dumps(capture(), ensure_ascii=False))
    except Exception:
        print("profile_fact_capture_failed", file=sys.stderr)
        raise SystemExit(2)
