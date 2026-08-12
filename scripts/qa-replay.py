#!/usr/bin/env python3
"""Prepare and evaluate supervised local Job Apply replay runs."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hmac
import json
import os
from pathlib import Path
import queue
import re
import secrets
import stat
import subprocess
import sys
import threading
from typing import Any
import urllib.error
import urllib.request
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from qa.oracle import OracleError, evaluate_run
from qa.contracts import ContractError, validate_fixture
from qa.recorder_fs import BrokerError, exclusive_rename


FIXTURES_ROOT = REPO_ROOT / "qa" / "fixtures"
SCENARIOS_ROOT = REPO_ROOT / "qa" / "scenarios"
RUNS_ROOT = REPO_ROOT / "qa" / "runs"
STORE_SCRIPT = REPO_ROOT / "scripts" / "job-apply-store.py"

IDENTIFIER = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
RUN_ID = re.compile(r"^qa-run-20[0-9]{6}-[a-f0-9]{8}$")
TOKEN = re.compile(r"^[a-f0-9]{64}$")
ROUTE = re.compile(
    r"^(qa-run-20[0-9]{6}-[a-f0-9]{8})\.([a-f0-9]{64})$"
)
MAX_JSON_BYTES = 1024 * 1024
MAX_RESUME_BYTES = 10 * 1024 * 1024
MAX_CLEANUP_ENTRIES = 2_000
MAX_CLEANUP_BYTES = 128 * 1024 * 1024
MAX_CLEANUP_DEPTH = 32
STARTUP_TIMEOUT_SECONDS = 10
REQUEST_TIMEOUT_SECONDS = 5
PROMPT = (
    "Use job-apply:job-apply on this approved local LinkedIn Easy Apply QA "
    "fixture: {url}. Use the isolated QA profile already prepared for this "
    "run. Operate the visible form normally and stop at final review exactly "
    "as you would on a live application."
)
RUN_STATE_KEYS = {
    "fixtureId",
    "scenarioId",
    "url",
    "storeRoot",
    "fixturePath",
    "routeToken",
    "shutdownToken",
    "lifecycleNonce",
    "createdAt",
}
EXPECTED_KEYS = {"controlIds", "resumeFilename"}
REPORT_KEYS = {
    "fixtureId",
    "scenarioId",
    "status",
    "assertions",
    "missingControlIds",
    "failureCategories",
}
ASSERTION_NAMES = {
    "required-fields-filled",
    "resume-uploaded",
    "resume-filename-matched",
    "review-reached",
    "history-started-reviewed",
    "history-not-completed",
    "session-present",
    "session-value-free",
    "final-action-untouched",
}
FAILURE_CATEGORIES = {
    "required-fields-missing",
    "required-upload-missing",
    "resume-filename-mismatch",
    "review-not-reached",
    "history-missing",
    "history-lifecycle-incomplete",
    "history-completed",
    "session-not-correlated",
    "session-missing",
    "session-value-present",
    "final-action-activated",
}


class CoordinatorError(ValueError):
    """A stable, value-free failure safe to display to the tester."""


def _open_private_directory(path: Path, diagnostic: str) -> int:
    descriptor = None
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
        )
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            raise CoordinatorError(diagnostic)
        return descriptor
    except CoordinatorError:
        if descriptor is not None:
            os.close(descriptor)
        raise
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
        raise CoordinatorError(diagnostic) from None


def _verify_directory_binding(path: Path, descriptor: int, diagnostic: str) -> None:
    try:
        bound = os.fstat(descriptor)
        current = path.lstat()
    except OSError:
        raise CoordinatorError(diagnostic) from None
    if (
        not stat.S_ISDIR(current.st_mode)
        or (bound.st_dev, bound.st_ino) != (current.st_dev, current.st_ino)
        or current.st_uid != os.getuid()
        or stat.S_IMODE(current.st_mode) != 0o700
    ):
        raise CoordinatorError(diagnostic)


def _read_regular_at(
    directory_descriptor: int, name: str, limit: int, diagnostic: str
) -> bytes:
    descriptor = None
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory_descriptor,
        )
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_size > limit
        ):
            raise CoordinatorError(diagnostic)
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            raise CoordinatorError(diagnostic)
        return data
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError(diagnostic) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_json_at(directory_descriptor: int, name: str, diagnostic: str) -> Any:
    try:
        return json.loads(
            _read_regular_at(
                directory_descriptor, name, MAX_JSON_BYTES, diagnostic
            ).decode()
        )
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise CoordinatorError(diagnostic) from None


def _entry_exists_at(directory_descriptor: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        raise CoordinatorError("invalid run state") from None


def _validate_report(
    report: Any, state: dict[str, Any], fixture: dict[str, Any]
) -> dict[str, Any]:
    control_ids = {
        control["id"]
        for step in fixture["steps"]
        for control in step["controls"]
        if control["required"]
    }
    if (
        not isinstance(report, dict)
        or set(report) != REPORT_KEYS
        or report.get("fixtureId") != state["fixtureId"]
        or report.get("scenarioId") != state["scenarioId"]
        or report.get("status") not in {"passed", "failed"}
    ):
        raise CoordinatorError("invalid run report")
    assertions = report.get("assertions")
    missing = report.get("missingControlIds")
    categories = report.get("failureCategories")
    if (
        not isinstance(assertions, dict)
        or set(assertions) != ASSERTION_NAMES
        or any(value not in {"passed", "failed"} for value in assertions.values())
        or not isinstance(missing, list)
        or len(missing) > len(control_ids)
        or not all(isinstance(value, str) for value in missing)
        or len(missing) != len(set(missing))
        or missing != sorted(missing)
        or not set(missing).issubset(control_ids)
        or not isinstance(categories, list)
        or len(categories) > len(FAILURE_CATEGORIES)
        or not all(isinstance(value, str) for value in categories)
        or len(categories) != len(set(categories))
        or categories != sorted(categories)
        or not set(categories).issubset(FAILURE_CATEGORIES)
    ):
        raise CoordinatorError("invalid run report")
    semantically_passed = (
        all(value == "passed" for value in assertions.values())
        and not missing
        and not categories
    )
    if (report["status"] == "passed") != semantically_passed:
        raise CoordinatorError("invalid run report")
    return report


def _atomic_json_at(
    directory_descriptor: int,
    name: str,
    value: dict[str, Any],
) -> None:
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = f".{name}.{secrets.token_hex(8)}.tmp"
    descriptor = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_descriptor,
        )
        os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(encoded):
            count = os.write(descriptor, encoded[written:])
            if count <= 0:
                raise OSError
            written += count
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        exclusive_rename(
            directory_descriptor,
            temporary,
            directory_descriptor,
            name,
        )
        os.fsync(directory_descriptor)
    except (OSError, BrokerError):
        raise CoordinatorError("run artifact write failed") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory_descriptor)
        except FileNotFoundError:
            pass


def _exclusive_json_at(
    directory_descriptor: int, name: str, value: dict[str, Any]
) -> None:
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    descriptor = None
    try:
        descriptor = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_descriptor,
        )
        os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(encoded):
            count = os.write(descriptor, encoded[written:])
            if count <= 0:
                raise OSError
            written += count
        os.fsync(descriptor)
        os.fsync(directory_descriptor)
    except OSError:
        raise CoordinatorError("run artifact write failed") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _copy_regular_at(
    source: Path,
    directory_descriptor: int,
    name: str,
    limit: int,
    diagnostic: str,
) -> None:
    data = _read_regular(source, limit, diagnostic)
    descriptor = None
    try:
        descriptor = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_descriptor,
        )
        os.fchmod(descriptor, 0o600)
        view = memoryview(data)
        while view:
            count = os.write(descriptor, view)
            if count <= 0:
                raise OSError
            view = view[count:]
        os.fsync(descriptor)
    except OSError:
        raise CoordinatorError(diagnostic) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _same_entry(expected: os.stat_result, observed: os.stat_result) -> bool:
    return (
        (expected.st_dev, expected.st_ino, stat.S_IFMT(expected.st_mode))
        == (observed.st_dev, observed.st_ino, stat.S_IFMT(observed.st_mode))
    )


def _restore_captured_entry(
    directory_descriptor: int, captured: str, original: str
) -> None:
    try:
        os.stat(original, dir_fd=directory_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        try:
            exclusive_rename(
                directory_descriptor,
                captured,
                directory_descriptor,
                original,
            )
        except (OSError, BrokerError):
            pass
    except OSError:
        pass


def _capture_and_remove_at(
    directory_descriptor: int,
    name: str,
    budget: dict[str, int],
    depth: int,
    expected_kind: str | None = None,
) -> None:
    if depth > MAX_CLEANUP_DEPTH:
        raise CoordinatorError("run cleanup failed") from None
    captured = f".cleanup-{secrets.token_hex(16)}"
    try:
        expected = os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
        parent = os.fstat(directory_descriptor)
        if (
            expected.st_uid != os.getuid()
            or expected.st_dev != parent.st_dev
            or not (stat.S_ISDIR(expected.st_mode) or stat.S_ISREG(expected.st_mode))
            or (expected_kind == "dir" and not stat.S_ISDIR(expected.st_mode))
            or (expected_kind == "file" and not stat.S_ISREG(expected.st_mode))
        ):
            raise CoordinatorError("run cleanup failed")
        expected_mode = 0o700 if stat.S_ISDIR(expected.st_mode) else 0o600
        if stat.S_IMODE(expected.st_mode) != expected_mode:
            raise CoordinatorError("run cleanup failed")
        budget["entries"] += 1
        if stat.S_ISREG(expected.st_mode):
            budget["bytes"] += expected.st_size
        if (
            budget["entries"] > MAX_CLEANUP_ENTRIES
            or budget["bytes"] > MAX_CLEANUP_BYTES
        ):
            raise CoordinatorError("run cleanup failed")
        exclusive_rename(
            directory_descriptor,
            name,
            directory_descriptor,
            captured,
        )
        renamed = os.stat(
            captured, dir_fd=directory_descriptor, follow_symlinks=False
        )
        if not _same_entry(expected, renamed):
            _restore_captured_entry(directory_descriptor, captured, name)
            raise CoordinatorError("run cleanup failed")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        if stat.S_ISDIR(expected.st_mode):
            flags |= os.O_DIRECTORY
        opened = os.open(captured, flags, dir_fd=directory_descriptor)
        try:
            if not _same_entry(expected, os.fstat(opened)):
                raise CoordinatorError("run cleanup failed")
            if stat.S_ISDIR(expected.st_mode):
                _remove_contents_at(opened, budget=budget, depth=depth + 1)
        finally:
            os.close(opened)
        final = os.stat(
            captured, dir_fd=directory_descriptor, follow_symlinks=False
        )
        if not _same_entry(expected, final):
            _restore_captured_entry(directory_descriptor, captured, name)
            raise CoordinatorError("run cleanup failed")
        if stat.S_ISDIR(expected.st_mode):
            os.rmdir(captured, dir_fd=directory_descriptor)
        else:
            os.unlink(captured, dir_fd=directory_descriptor)
    except CoordinatorError:
        _restore_captured_entry(directory_descriptor, captured, name)
        raise
    except (OSError, BrokerError):
        _restore_captured_entry(directory_descriptor, captured, name)
        raise CoordinatorError("run cleanup failed") from None


def _remove_contents_at(
    directory_descriptor: int,
    depth: int = 0,
    *,
    budget: dict[str, int] | None = None,
) -> None:
    if budget is None:
        budget = {"entries": 0, "bytes": 0}
    if depth > MAX_CLEANUP_DEPTH:
        raise CoordinatorError("run cleanup failed")
    while True:
        try:
            names = os.listdir(directory_descriptor)
        except OSError:
            raise CoordinatorError("run cleanup failed") from None
        if len(names) > MAX_CLEANUP_ENTRIES - budget["entries"]:
            raise CoordinatorError("run cleanup failed")
        if not names:
            return
        for name in names:
            _capture_and_remove_at(directory_descriptor, name, budget, depth)


def _read_regular(path: Path, limit: int, diagnostic: str) -> bytes:
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise CoordinatorError(diagnostic)
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            raise CoordinatorError(diagnostic)
        return data
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError(diagnostic) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_json(path: Path, diagnostic: str) -> Any:
    try:
        return json.loads(_read_regular(path, MAX_JSON_BYTES, diagnostic).decode())
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise CoordinatorError(diagnostic) from None


def _validate_source_directory(path: Path, diagnostic: str) -> None:
    try:
        metadata = path.lstat()
    except OSError:
        raise CoordinatorError(diagnostic) from None
    if not stat.S_ISDIR(metadata.st_mode):
        raise CoordinatorError(diagnostic)


def _run_store(store_root: Path, command: list[str]) -> None:
    disabled_legacy = store_root.parent / ".legacy-profile-disabled.json"
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(STORE_SCRIPT),
                "--root",
                str(store_root),
                "--legacy-profile",
                str(disabled_legacy),
                *command,
            ],
            cwd=REPO_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CoordinatorError("isolated store initialization failed") from None
    if result.returncode != 0:
        raise CoordinatorError("isolated store initialization failed")


def _start_server(
    fixture_path: Path,
    expected_resume_filename: str,
    shutdown_token: str,
) -> dict[str, Any]:
    server_environment = os.environ.copy()
    server_environment["JOB_APPLY_QA_SHUTDOWN_TOKEN"] = shutdown_token
    try:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "qa.server",
                "--fixture",
                str(fixture_path),
                "--port",
                "0",
                "--expected-resume-filename",
                expected_resume_filename,
            ],
            cwd=REPO_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
            env=server_environment,
        )
    except OSError:
        raise CoordinatorError("fixture server startup failed") from None

    lines: queue.Queue[str] = queue.Queue(maxsize=1)
    assert process.stdout is not None
    reader = threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True)
    reader.start()
    try:
        line = lines.get(timeout=STARTUP_TIMEOUT_SECONDS)
        startup = json.loads(line)
        if (
            set(startup) != {"url", "port", "fixtureId"}
            or startup["fixtureId"] == ""
            or startup["url"] != f"http://127.0.0.1:{startup['port']}"
            or not isinstance(startup["port"], int)
        ):
            raise ValueError
        # The server intentionally outlives this command. Mark this local handle as
        # detached so Popen's destructor does not report the expected live child.
        process.returncode = 0
        return startup
    except (queue.Empty, json.JSONDecodeError, TypeError, ValueError):
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        raise CoordinatorError("fixture server startup failed") from None
    finally:
        process.stdout.close()


def _new_run_directory() -> tuple[str, Path, int, int]:
    try:
        created = False
        try:
            RUNS_ROOT.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        if not stat.S_ISDIR(RUNS_ROOT.lstat().st_mode):
            raise OSError
        if created:
            os.chmod(RUNS_ROOT, 0o700)
        root_descriptor = _open_private_directory(
            RUNS_ROOT, "run directory creation failed"
        )
        for _ in range(16):
            date = datetime.now(timezone.utc).strftime("%Y%m%d")
            run_id = f"qa-run-{date}-{secrets.token_hex(4)}"
            run_root = RUNS_ROOT / run_id
            try:
                os.mkdir(run_id, 0o700, dir_fd=root_descriptor)
                run_descriptor = os.open(
                    run_id,
                    os.O_RDONLY
                    | os.O_DIRECTORY
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=root_descriptor,
                )
                os.fchmod(run_descriptor, 0o700)
                return run_id, run_root, root_descriptor, run_descriptor
            except FileExistsError:
                continue
    except OSError:
        pass
    try:
        os.close(root_descriptor)
    except (NameError, OSError):
        pass
    raise CoordinatorError("run directory creation failed")


def _prepare(fixture_id: str, scenario_id: str) -> dict[str, Any]:
    if IDENTIFIER.fullmatch(fixture_id) is None:
        raise CoordinatorError("invalid fixture identifier")
    if IDENTIFIER.fullmatch(scenario_id) is None:
        raise CoordinatorError("invalid scenario identifier")
    fixture_dir = FIXTURES_ROOT / fixture_id
    scenario_dir = SCENARIOS_ROOT / scenario_id
    _validate_source_directory(fixture_dir, "invalid fixture package")
    _validate_source_directory(scenario_dir, "invalid scenario package")
    fixture_path = fixture_dir / "fixture.json"
    profile_path = scenario_dir / "profile.json"
    resume_path = scenario_dir / "synthetic-resume.pdf"
    expected_path = scenario_dir / "expected.json"
    fixture = _read_json(fixture_path, "invalid fixture package")
    profile = _read_json(profile_path, "invalid scenario package")
    expected = _read_json(expected_path, "invalid scenario package")
    try:
        validate_fixture(fixture)
    except (ContractError, TypeError):
        raise CoordinatorError("invalid fixture package") from None
    if fixture.get("id") != fixture_id:
        raise CoordinatorError("invalid fixture package")
    if not isinstance(profile, dict):
        raise CoordinatorError("invalid scenario package")
    fixture_control_ids = [
        control["id"]
        for step in fixture.get("steps", [])
        for control in step.get("controls", [])
    ]
    if (
        not isinstance(expected, dict)
        or set(expected) != EXPECTED_KEYS
        or expected.get("controlIds") != fixture_control_ids
        or expected.get("resumeFilename") != "synthetic-resume.pdf"
    ):
        raise CoordinatorError("invalid scenario package")

    _run_id, run_root, runs_descriptor, run_descriptor = _new_run_directory()
    startup: dict[str, Any] | None = None
    shutdown_token = secrets.token_hex(32)
    route_token = secrets.token_hex(32)
    run_descriptor_open = True
    try:
        _verify_directory_binding(run_root, run_descriptor, "run directory changed")
        store_root = run_root / "store"
        copied_fixture = run_root / "fixture.json"
        copied_profile = run_root / "profile.json"
        copied_resume = run_root / "synthetic-resume.pdf"
        copied_expected = run_root / "expected.json"
        _copy_regular_at(fixture_path, run_descriptor, "fixture.json", MAX_JSON_BYTES, "invalid fixture package")
        _copy_regular_at(profile_path, run_descriptor, "profile.json", MAX_JSON_BYTES, "invalid scenario package")
        _copy_regular_at(resume_path, run_descriptor, "synthetic-resume.pdf", MAX_RESUME_BYTES, "invalid scenario package")
        _copy_regular_at(expected_path, run_descriptor, "expected.json", MAX_JSON_BYTES, "invalid scenario package")

        prepared_profile = dict(profile)
        prepared_profile["resumePath"] = str(copied_resume.resolve())
        _run_store(store_root, ["init"])
        _verify_directory_binding(run_root, run_descriptor, "run directory changed")
        prepared_path = run_root / ".prepared-profile.json"
        _atomic_json_at(run_descriptor, ".prepared-profile.json", prepared_profile)
        _run_store(
            store_root,
            [
                "profile-replace",
                "--input",
                str(prepared_path),
            ],
        )
        _verify_directory_binding(run_root, run_descriptor, "run directory changed")
        os.unlink(".prepared-profile.json", dir_fd=run_descriptor)

        startup = _start_server(
            copied_fixture.resolve(),
            expected["resumeFilename"],
            shutdown_token,
        )
        _verify_directory_binding(run_root, run_descriptor, "run directory changed")
        if startup["fixtureId"] != fixture_id:
            raise CoordinatorError("fixture server startup failed")
        state = {
            "fixtureId": fixture_id,
            "scenarioId": scenario_id,
            "url": startup["url"],
            "storeRoot": str(store_root.resolve()),
            "fixturePath": str(copied_fixture.resolve()),
            "routeToken": route_token,
            "shutdownToken": shutdown_token,
            "lifecycleNonce": secrets.token_hex(32),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        _atomic_json_at(run_descriptor, "run.json", state)
        _atomic_json_at(
            run_descriptor,
            "lifecycle.json",
            {"state": "prepared", "nonce": state["lifecycleNonce"]},
        )
        return {
            "fixtureId": fixture_id,
            "scenarioId": scenario_id,
            "url": f'{startup["url"]}#qa-route={_run_id}.{route_token}',
            "storeRoot": str(store_root.resolve()),
            "suggestedPrompt": PROMPT.format(
                url=f'{startup["url"]}#qa-route={_run_id}.{route_token}'
            ),
        }
    except BaseException:
        if startup is not None:
            _shutdown_server(startup["url"], shutdown_token, required=False)
        try:
            _remove_contents_at(run_descriptor)
            os.close(run_descriptor)
            run_descriptor_open = False
            os.rmdir(_run_id, dir_fd=runs_descriptor)
            os.fsync(runs_descriptor)
        except (CoordinatorError, OSError):
            pass
        raise
    finally:
        if run_descriptor_open:
            os.close(run_descriptor)
        os.close(runs_descriptor)


def _load_state_at(run_root: Path, run_descriptor: int) -> dict[str, Any]:
    state = _read_json_at(run_descriptor, "run.json", "invalid run state")
    if (
        not isinstance(state, dict)
        or set(state) != RUN_STATE_KEYS
        or not all(isinstance(state.get(key), str) for key in RUN_STATE_KEYS)
        or TOKEN.fullmatch(state["routeToken"]) is None
        or TOKEN.fullmatch(state["shutdownToken"]) is None
        or TOKEN.fullmatch(state["lifecycleNonce"]) is None
        or Path(state["storeRoot"]) != run_root / "store"
        or Path(state["fixturePath"]) != run_root / "fixture.json"
        or state["scenarioId"] != "complete-profile"
    ):
        raise CoordinatorError("invalid run state")
    return state


def _load_run(run_id: str) -> tuple[Path, dict[str, Any], int, int]:
    if RUN_ID.fullmatch(run_id) is None:
        raise CoordinatorError("invalid run identifier")
    run_root = RUNS_ROOT / run_id
    canonical_run_root = RUNS_ROOT.resolve() / run_id
    root_descriptor = _open_private_directory(RUNS_ROOT, "invalid run state")
    run_descriptor = None
    try:
        run_descriptor = os.open(
            run_id,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=root_descriptor,
        )
        metadata = os.fstat(run_descriptor)
        if (
            metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            raise CoordinatorError("invalid run state")
        _verify_directory_binding(RUNS_ROOT, root_descriptor, "invalid run state")
        _verify_directory_binding(run_root, run_descriptor, "invalid run state")
        state = _load_state_at(canonical_run_root, run_descriptor)
    except BaseException:
        if run_descriptor is not None:
            os.close(run_descriptor)
        os.close(root_descriptor)
        raise
    return run_root, state, root_descriptor, run_descriptor


def _fetch_state(url: str) -> dict[str, Any]:
    url = _base_url(url)
    try:
        request = urllib.request.Request(url + "/__qa/state", method="GET")
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise CoordinatorError("fixture server unavailable")
            body = response.read(MAX_JSON_BYTES + 1)
        if len(body) > MAX_JSON_BYTES:
            raise CoordinatorError("invalid fixture server state")
        state = json.loads(body.decode())
    except CoordinatorError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, urllib.error.URLError):
        raise CoordinatorError("fixture server unavailable") from None
    if (
        not isinstance(state, dict)
        or set(state) != {"events", "finalActionActivations"}
        or not isinstance(state["events"], list)
        or not isinstance(state["finalActionActivations"], int)
        or isinstance(state["finalActionActivations"], bool)
        or state["finalActionActivations"] < 0
    ):
        raise CoordinatorError("invalid fixture server state")
    return state


def _base_url(url: str) -> str:
    parsed = urlsplit(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    if re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", base) is None:
        raise CoordinatorError("invalid run state")
    return base


def _authenticated_request(
    url: str, path: str, token: str, method: str = "GET"
) -> tuple[int, bytes]:
    try:
        request = urllib.request.Request(
            _base_url(url) + path,
            headers={"X-QA-Run-Token": token},
            method=method,
        )
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return response.status, response.read(MAX_JSON_BYTES + 1)
    except urllib.error.HTTPError as error:
        error.read()
        return error.code, b""
    except (OSError, urllib.error.URLError):
        raise CoordinatorError("fixture server unavailable") from None


def _verify_identity(state: dict[str, Any]) -> None:
    status, body = _authenticated_request(
        state["url"], "/__qa/identity", state["shutdownToken"]
    )
    try:
        identity = json.loads(body.decode())
    except (UnicodeError, json.JSONDecodeError):
        identity = None
    if status != 200 or identity != {"fixtureId": state["fixtureId"]}:
        raise CoordinatorError("fixture server identity mismatch")


def _shutdown_server(url: str, token: str, required: bool = True) -> None:
    try:
        status, _body = _authenticated_request(
            url, "/__qa/shutdown", token, method="POST"
        )
    except CoordinatorError:
        if required:
            raise
        return
    if status != 204 and required:
        raise CoordinatorError("fixture server shutdown failed")


def _resolve_route(route_token: str) -> dict[str, str]:
    match = ROUTE.fullmatch(route_token)
    if match is None:
        raise CoordinatorError("unknown QA route")
    run_id, supplied_token = match.groups()
    root_descriptor = run_descriptor = None
    try:
        _run_root, state, root_descriptor, run_descriptor = _load_run(run_id)
        lifecycle = _read_json_at(
            run_descriptor, "lifecycle.json", "invalid run state"
        )
        terminal = _entry_exists_at(
            run_descriptor, "completed.json"
        ) or _entry_exists_at(run_descriptor, "abandoned.json")
        if (
            terminal
            or lifecycle != {
                "state": "prepared",
                "nonce": state["lifecycleNonce"],
            }
            or not hmac.compare_digest(state["routeToken"], supplied_token)
        ):
            raise CoordinatorError("unknown QA route")
        return {"storeRoot": state["storeRoot"]}
    except CoordinatorError:
        raise CoordinatorError("unknown QA route")
    finally:
        if run_descriptor is not None:
            os.close(run_descriptor)
        if root_descriptor is not None:
            os.close(root_descriptor)


def _evaluate(run_id: str) -> tuple[int, dict[str, Any]]:
    _run_root, state, root_descriptor, run_descriptor = _load_run(run_id)
    lock_descriptor = None
    authenticated = False
    lifecycle_active = False
    store_descriptor = None
    try:
        lock_descriptor = os.open(
            "evaluate.lock",
            os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=run_descriptor,
        )
        os.fchmod(lock_descriptor, 0o600)
        try:
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CoordinatorError("evaluation already in progress") from None
        fixture = _read_json_at(
            run_descriptor, "fixture.json", "invalid fixture package"
        )
        try:
            validate_fixture(fixture)
        except (ContractError, TypeError):
            raise CoordinatorError("invalid fixture package") from None
        try:
            completed = _read_json_at(
                run_descriptor, "report.json", "invalid run report"
            )
        except CoordinatorError:
            try:
                os.stat("report.json", dir_fd=run_descriptor, follow_symlinks=False)
            except FileNotFoundError:
                completed = None
            else:
                raise
        if completed is not None:
            completed_marker = _read_json_at(
                run_descriptor, "completed.json", "invalid run report"
            )
            if completed_marker != {
                "state": "completed",
                "nonce": state["lifecycleNonce"],
            }:
                raise CoordinatorError("invalid run report")
            completed = _validate_report(completed, state, fixture)
            return (0 if completed["status"] == "passed" else 1), completed
        lifecycle = _read_json_at(
            run_descriptor, "lifecycle.json", "invalid run state"
        )
        if _entry_exists_at(run_descriptor, "abandoned.json"):
            raise CoordinatorError("run is abandoned")
        if lifecycle != {"state": "prepared", "nonce": state["lifecycleNonce"]}:
            raise CoordinatorError("run is abandoned")
        lifecycle_active = True
        try:
            store_descriptor = os.open(
                "store",
                os.O_RDONLY
                | os.O_DIRECTORY
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=run_descriptor,
            )
            store_metadata = os.fstat(store_descriptor)
            if (
                not stat.S_ISDIR(store_metadata.st_mode)
                or store_metadata.st_uid != os.getuid()
                or stat.S_IMODE(store_metadata.st_mode) != 0o700
            ):
                raise CoordinatorError("invalid store root")
        except CoordinatorError:
            raise
        except OSError:
            raise CoordinatorError("invalid store root") from None
        _verify_identity(state)
        authenticated = True
        server_state = _fetch_state(state["url"])
        report = evaluate_run(
            fixture,
            {"id": state["scenarioId"]},
            server_state["events"],
            store_descriptor,
        )
        if not isinstance(report, dict):
            raise CoordinatorError("replay evaluation failed")
        report = _validate_report(report, state, fixture)
        _shutdown_server(state["url"], state["shutdownToken"], required=True)
        authenticated = False
        _atomic_json_at(run_descriptor, "report.json", report)
        _atomic_json_at(
            run_descriptor,
            "completed.json",
            {"state": "completed", "nonce": state["lifecycleNonce"]},
        )
        return (0 if report.get("status") == "passed" else 1), report
    except OracleError as error:
        if lifecycle_active:
            try:
                _atomic_json_at(
                    run_descriptor,
                    "abandoned.json",
                    {"state": "abandoned", "nonce": state["lifecycleNonce"]},
                )
            except CoordinatorError:
                pass
        raise CoordinatorError(str(error)) from None
    except CoordinatorError:
        if lifecycle_active:
            try:
                _atomic_json_at(
                    run_descriptor,
                    "abandoned.json",
                    {"state": "abandoned", "nonce": state["lifecycleNonce"]},
                )
            except CoordinatorError:
                pass
        raise
    finally:
        if authenticated:
            _shutdown_server(state["url"], state["shutdownToken"], required=False)
        if lock_descriptor is not None:
            os.close(lock_descriptor)
        if store_descriptor is not None:
            os.close(store_descriptor)
        os.close(run_descriptor)
        os.close(root_descriptor)


def _open_run_for_cleanup(run_id: str) -> tuple[Path, Path, int, int]:
    if RUN_ID.fullmatch(run_id) is None:
        raise CoordinatorError("invalid run identifier")
    run_root = RUNS_ROOT / run_id
    canonical_run_root = RUNS_ROOT.resolve() / run_id
    root_descriptor = _open_private_directory(RUNS_ROOT, "invalid run state")
    run_descriptor = None
    try:
        run_descriptor = os.open(
            run_id,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=root_descriptor,
        )
        _verify_directory_binding(RUNS_ROOT, root_descriptor, "invalid run state")
        _verify_directory_binding(run_root, run_descriptor, "invalid run state")
        return run_root, canonical_run_root, root_descriptor, run_descriptor
    except BaseException:
        if run_descriptor is not None:
            os.close(run_descriptor)
        os.close(root_descriptor)
        raise


def _preflight_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    budget: dict[str, int],
    depth: int,
) -> None:
    if depth > MAX_CLEANUP_DEPTH:
        raise CoordinatorError("run cleanup failed")
    try:
        names = tuple(sorted(os.listdir(directory_descriptor)))
        if len(names) > MAX_CLEANUP_ENTRIES - budget["entries"]:
            raise CoordinatorError("run cleanup failed")
        children[prefix] = names
        parent = os.fstat(directory_descriptor)
        for name in names:
            metadata = os.stat(
                name, dir_fd=directory_descriptor, follow_symlinks=False
            )
            is_directory = stat.S_ISDIR(metadata.st_mode)
            is_file = stat.S_ISREG(metadata.st_mode)
            expected_mode = 0o700 if is_directory else 0o600
            if (
                metadata.st_uid != os.getuid()
                or metadata.st_dev != parent.st_dev
                or not (is_directory or is_file)
                or stat.S_IMODE(metadata.st_mode) != expected_mode
            ):
                raise CoordinatorError("run cleanup failed")
            budget["entries"] += 1
            if is_file:
                budget["bytes"] += metadata.st_size
            if (
                budget["entries"] > MAX_CLEANUP_ENTRIES
                or budget["bytes"] > MAX_CLEANUP_BYTES
            ):
                raise CoordinatorError("run cleanup failed")
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            if is_directory:
                flags |= os.O_DIRECTORY
            opened = os.open(name, flags, dir_fd=directory_descriptor)
            try:
                if not _same_entry(metadata, os.fstat(opened)):
                    raise CoordinatorError("run cleanup failed")
                path = prefix + (name,)
                manifest[path] = metadata
                if is_directory:
                    _preflight_cleanup_tree(
                        opened, path, manifest, children, budget, depth + 1
                    )
            finally:
                os.close(opened)
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


def _sanitize_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    retained: set[tuple[str, ...]],
) -> None:
    try:
        expected_names = children[prefix]
        if tuple(sorted(os.listdir(directory_descriptor))) != expected_names:
            raise CoordinatorError("run cleanup failed")
        for name in expected_names:
            path = prefix + (name,)
            expected = manifest[path]
            current = os.stat(
                name, dir_fd=directory_descriptor, follow_symlinks=False
            )
            if not _same_entry(expected, current):
                raise CoordinatorError("run cleanup failed")
            is_directory = stat.S_ISDIR(expected.st_mode)
            flags = os.O_RDONLY if is_directory or path in retained else os.O_WRONLY
            flags |= getattr(os, "O_NOFOLLOW", 0)
            if is_directory:
                flags |= os.O_DIRECTORY
            opened = os.open(name, flags, dir_fd=directory_descriptor)
            try:
                if not _same_entry(expected, os.fstat(opened)):
                    raise CoordinatorError("run cleanup failed")
                if is_directory:
                    _sanitize_cleanup_tree(
                        opened, path, manifest, children, retained
                    )
                elif path not in retained:
                    os.ftruncate(opened, 0)
                    os.fsync(opened)
            finally:
                os.close(opened)
        if tuple(sorted(os.listdir(directory_descriptor))) != expected_names:
            raise CoordinatorError("run cleanup failed")
        for name in expected_names:
            if not _same_entry(
                manifest[prefix + (name,)],
                os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False),
            ):
                raise CoordinatorError("run cleanup failed")
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


def _verify_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    retained: set[tuple[str, ...]],
) -> None:
    try:
        expected_names = children[prefix]
        if tuple(sorted(os.listdir(directory_descriptor))) != expected_names:
            raise CoordinatorError("run cleanup failed")
        for name in expected_names:
            path = prefix + (name,)
            expected = manifest[path]
            current = os.stat(
                name, dir_fd=directory_descriptor, follow_symlinks=False
            )
            if not _same_entry(expected, current):
                raise CoordinatorError("run cleanup failed")
            is_directory = stat.S_ISDIR(expected.st_mode)
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            if is_directory:
                flags |= os.O_DIRECTORY
            opened = os.open(name, flags, dir_fd=directory_descriptor)
            try:
                opened_metadata = os.fstat(opened)
                if not _same_entry(expected, opened_metadata):
                    raise CoordinatorError("run cleanup failed")
                if is_directory:
                    _verify_cleanup_tree(
                        opened, path, manifest, children, retained
                    )
                elif path not in retained and opened_metadata.st_size != 0:
                    raise CoordinatorError("run cleanup failed")
            finally:
                os.close(opened)
        if tuple(sorted(os.listdir(directory_descriptor))) != expected_names:
            raise CoordinatorError("run cleanup failed")
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


def _sanitize_run_artifacts(
    run_descriptor: int, *, retain_report: bool
) -> None:
    retained = {"tombstone.json"}
    if retain_report:
        retained.add("report.json")
    allowed_files = {
        "fixture.json",
        "profile.json",
        "synthetic-resume.pdf",
        "expected.json",
        "run.json",
        "lifecycle.json",
        "completed.json",
        "abandoned.json",
        "report.json",
        "evaluate.lock",
        "tombstone.json",
    }
    manifest: dict[tuple[str, ...], os.stat_result] = {}
    children: dict[tuple[str, ...], tuple[str, ...]] = {}
    _preflight_cleanup_tree(
        run_descriptor,
        (),
        manifest,
        children,
        {"entries": 0, "bytes": 0},
        0,
    )
    if any(path[0] != "store" and path[0] not in allowed_files for path in manifest):
        raise CoordinatorError("run cleanup failed")
    retained_paths = {(name,) for name in retained}
    _sanitize_cleanup_tree(
        run_descriptor, (), manifest, children, retained_paths
    )
    _verify_cleanup_tree(
        run_descriptor, (), manifest, children, retained_paths
    )
    try:
        os.fsync(run_descriptor)
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


def _cleanup(run_id: str) -> dict[str, Any]:
    (
        _run_root,
        canonical_run_root,
        root_descriptor,
        run_descriptor,
    ) = _open_run_for_cleanup(run_id)
    lock_descriptor = None
    try:
        lock_descriptor = os.open(
            "evaluate.lock",
            os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=run_descriptor,
        )
        os.fchmod(lock_descriptor, 0o600)
        try:
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CoordinatorError("evaluation already in progress") from None

        if _entry_exists_at(run_descriptor, "tombstone.json"):
            tombstone = _read_json_at(
                run_descriptor, "tombstone.json", "invalid cleanup state"
            )
            if (
                not isinstance(tombstone, dict)
                or set(tombstone) != {"runId", "state", "reportRetained"}
                or tombstone.get("runId") != run_id
                or tombstone.get("state") not in {"abandoned", "completed"}
                or not isinstance(tombstone.get("reportRetained"), bool)
                or tombstone["reportRetained"]
                != (tombstone["state"] == "completed")
            ):
                raise CoordinatorError("invalid cleanup state")
            _sanitize_run_artifacts(
                run_descriptor, retain_report=tombstone["reportRetained"]
            )
            return tombstone

        state = _load_state_at(canonical_run_root, run_descriptor)
        lifecycle = _read_json_at(
            run_descriptor, "lifecycle.json", "invalid run state"
        )
        expected_prepared = {
            "state": "prepared",
            "nonce": state["lifecycleNonce"],
        }
        if lifecycle != expected_prepared:
            raise CoordinatorError("invalid run state")
        completed = _entry_exists_at(run_descriptor, "completed.json")
        abandoned = _entry_exists_at(run_descriptor, "abandoned.json")
        if completed and abandoned:
            raise CoordinatorError("invalid run state")
        if completed:
            if _read_json_at(
                run_descriptor, "completed.json", "invalid run state"
            ) != {"state": "completed", "nonce": state["lifecycleNonce"]}:
                raise CoordinatorError("invalid run state")
            fixture = _read_json_at(
                run_descriptor,
                "fixture.json",
                "invalid fixture package",
            )
            try:
                validate_fixture(fixture)
            except (ContractError, TypeError):
                raise CoordinatorError("invalid fixture package") from None
            report = _read_json_at(
                run_descriptor, "report.json", "invalid run report"
            )
            _validate_report(report, state, fixture)
            cleanup_state = "completed"
            retain_report = True
        elif not abandoned:
            try:
                _verify_identity(state)
            except CoordinatorError as error:
                if str(error) != "fixture server unavailable":
                    raise
            else:
                _shutdown_server(
                    state["url"], state["shutdownToken"], required=True
                )
            _exclusive_json_at(
                run_descriptor,
                "abandoned.json",
                {"state": "abandoned", "nonce": state["lifecycleNonce"]},
            )
            cleanup_state = "abandoned"
            retain_report = False
        elif abandoned:
            if _read_json_at(
                run_descriptor, "abandoned.json", "invalid run state"
            ) != {"state": "abandoned", "nonce": state["lifecycleNonce"]}:
                raise CoordinatorError("invalid run state")
            cleanup_state = "abandoned"
            retain_report = False
        else:
            raise CoordinatorError("invalid run state")

        tombstone = {
            "runId": run_id,
            "state": cleanup_state,
            "reportRetained": retain_report,
        }
        _exclusive_json_at(run_descriptor, "tombstone.json", tombstone)
        _sanitize_run_artifacts(run_descriptor, retain_report=retain_report)
        return tombstone
    finally:
        if lock_descriptor is not None:
            os.close(lock_descriptor)
        os.close(run_descriptor)
        os.close(root_descriptor)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--fixture", required=True)
    prepare.add_argument("--scenario", required=True)
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--run-id", required=True)
    resolve = commands.add_parser("resolve")
    resolve.add_argument("--route-token", required=True)
    cleanup = commands.add_parser("cleanup")
    cleanup.add_argument("--run-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        if arguments.command == "prepare":
            result = _prepare(arguments.fixture, arguments.scenario)
            code = 0
        elif arguments.command == "evaluate":
            code, result = _evaluate(arguments.run_id)
        elif arguments.command == "resolve":
            result = _resolve_route(arguments.route_token)
            code = 0
        else:
            result = _cleanup(arguments.run_id)
            code = 0
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return code
    except CoordinatorError as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
