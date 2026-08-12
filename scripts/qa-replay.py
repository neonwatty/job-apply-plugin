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
MAX_JSON_BYTES = 1024 * 1024
MAX_RESUME_BYTES = 10 * 1024 * 1024
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
MAX_RUN_ENTRIES = 256
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
        control["id"] for step in fixture["steps"] for control in step["controls"]
    }
    if (
        not isinstance(report, dict)
        or set(report) != REPORT_KEYS
        or report.get("fixtureId") != state["fixtureId"]
        or report.get("scenarioId") != state["scenarioId"]
        or report.get("status") not in {"passed", "failed"}
        or not isinstance(report.get("assertions"), dict)
        or set(report["assertions"]) != ASSERTION_NAMES
        or any(
            value not in {"passed", "failed"}
            for value in report["assertions"].values()
        )
        or not isinstance(report.get("missingControlIds"), list)
        or any(value not in control_ids for value in report["missingControlIds"])
        or not isinstance(report.get("failureCategories"), list)
        or any(
            value not in FAILURE_CATEGORIES
            for value in report["failureCategories"]
        )
    ):
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


def _remove_contents_at(directory_descriptor: int, depth: int = 0) -> None:
    if depth > 32:
        raise CoordinatorError("run cleanup failed")
    try:
        names = os.listdir(directory_descriptor)
        if len(names) > 2_000:
            raise CoordinatorError("run cleanup failed")
        for name in names:
            metadata = os.stat(
                name, dir_fd=directory_descriptor, follow_symlinks=False
            )
            if stat.S_ISDIR(metadata.st_mode):
                child = os.open(
                    name,
                    os.O_RDONLY
                    | os.O_DIRECTORY
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=directory_descriptor,
                )
                try:
                    _remove_contents_at(child, depth + 1)
                finally:
                    os.close(child)
                os.rmdir(name, dir_fd=directory_descriptor)
            elif stat.S_ISREG(metadata.st_mode):
                os.unlink(name, dir_fd=directory_descriptor)
            else:
                raise CoordinatorError("run cleanup failed")
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError("run cleanup failed") from None


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
            "url": f'{startup["url"]}#qa-route={route_token}',
            "storeRoot": str(store_root.resolve()),
            "suggestedPrompt": PROMPT.format(
                url=f'{startup["url"]}#qa-route={route_token}'
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


def _load_run(run_id: str) -> tuple[Path, dict[str, Any], int, int]:
    if RUN_ID.fullmatch(run_id) is None:
        raise CoordinatorError("invalid run identifier")
    run_root = RUNS_ROOT / run_id
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
        state = _read_json_at(run_descriptor, "run.json", "invalid run state")
    except BaseException:
        if run_descriptor is not None:
            os.close(run_descriptor)
        os.close(root_descriptor)
        raise
    if (
        not isinstance(state, dict)
        or set(state) != RUN_STATE_KEYS
        or not all(
            isinstance(state.get(key), str)
            for key in RUN_STATE_KEYS
        )
        or TOKEN.fullmatch(state["routeToken"]) is None
        or TOKEN.fullmatch(state["shutdownToken"]) is None
        or TOKEN.fullmatch(state["lifecycleNonce"]) is None
        or Path(state["storeRoot"]) != (run_root / "store").resolve()
        or Path(state["fixturePath"]) != (run_root / "fixture.json").resolve()
        or state["scenarioId"] != "complete-profile"
    ):
        os.close(run_descriptor)
        os.close(root_descriptor)
        raise CoordinatorError("invalid run state")
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
    if TOKEN.fullmatch(route_token) is None:
        raise CoordinatorError("invalid QA route")
    scan_descriptor = _open_private_directory(RUNS_ROOT, "unknown QA route")
    try:
        with os.scandir(scan_descriptor) as iterator:
            names = [entry.name for entry in iterator]
    except OSError:
        raise CoordinatorError("unknown QA route") from None
    finally:
        os.close(scan_descriptor)
    if len(names) > MAX_RUN_ENTRIES:
        raise CoordinatorError("unknown QA route")
    match: str | None = None
    for name in names:
        if RUN_ID.fullmatch(name) is None:
            continue
        root_descriptor = run_descriptor = None
        try:
            _run_root, state, root_descriptor, run_descriptor = _load_run(name)
            lifecycle = _read_json_at(
                run_descriptor, "lifecycle.json", "invalid run state"
            )
            terminal = _entry_exists_at(
                run_descriptor, "completed.json"
            ) or _entry_exists_at(run_descriptor, "abandoned.json")
        except CoordinatorError:
            continue
        finally:
            if run_descriptor is not None:
                os.close(run_descriptor)
            if root_descriptor is not None:
                os.close(root_descriptor)
        if terminal or lifecycle != {
            "state": "prepared",
            "nonce": state["lifecycleNonce"],
        }:
            continue
        if hmac.compare_digest(state["routeToken"], route_token):
            if match is not None:
                raise CoordinatorError("unknown QA route")
            match = state["storeRoot"]
    if match is None:
        raise CoordinatorError("unknown QA route")
    return {"storeRoot": match}


def _evaluate(run_id: str) -> tuple[int, dict[str, Any]]:
    _run_root, state, root_descriptor, run_descriptor = _load_run(run_id)
    lock_descriptor = None
    authenticated = False
    lifecycle_active = False
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
        _verify_identity(state)
        authenticated = True
        server_state = _fetch_state(state["url"])
        report = evaluate_run(
            fixture,
            {"id": state["scenarioId"]},
            server_state["events"],
            Path(state["storeRoot"]),
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
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        if arguments.command == "prepare":
            result = _prepare(arguments.fixture, arguments.scenario)
            code = 0
        elif arguments.command == "evaluate":
            code, result = _evaluate(arguments.run_id)
        else:
            result = _resolve_route(arguments.route_token)
            code = 0
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return code
    except CoordinatorError as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
